import { createServer as createNetServer, connect, type Server as NetServer, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { installClientGoneSocketGuard, isClientGoneSocketError } from "./socket-guard.js";

describe("isClientGoneSocketError", () => {
  it("recognizes EPIPE and ECONNRESET", () => {
    expect(isClientGoneSocketError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    expect(isClientGoneSocketError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))).toBe(true);
  });

  it("rejects other error codes", () => {
    expect(isClientGoneSocketError(Object.assign(new Error("nope"), { code: "EACCES" }))).toBe(false);
    expect(isClientGoneSocketError(Object.assign(new Error("nope"), { code: "ETIMEDOUT" }))).toBe(false);
  });

  it("rejects errors without a code, and non-error values", () => {
    expect(isClientGoneSocketError(new Error("no code here"))).toBe(false);
    expect(isClientGoneSocketError("EPIPE")).toBe(false);
    expect(isClientGoneSocketError(null)).toBe(false);
    expect(isClientGoneSocketError(undefined)).toBe(false);
    expect(isClientGoneSocketError({ code: "EPIPE" })).toBe(false); // not an Error instance
  });
});

describe("installClientGoneSocketGuard", () => {
  let server: NetServer | null = null;
  let uncaughtExceptionHandler: ((err: unknown) => void) | null = null;

  afterEach(async () => {
    if (uncaughtExceptionHandler) {
      process.removeListener("uncaughtException", uncaughtExceptionHandler as NodeJS.UncaughtExceptionListener);
      uncaughtExceptionHandler = null;
    }
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
  });

  it(
    "does not crash the process when a client resets the connection mid-write (real socket, real RST)",
    async () => {
      // This reproduces the actual GOT-2091 crash shape: a client tears down
      // its end of the connection (here via a genuine TCP RST, the same
      // thing a piped CLI whose consumer exits early — `grep -q`, `head -1`
      // — or a browser navigating away produces at the socket level), and
      // the server keeps writing to the now-dead socket. Without the guard,
      // Node's default "throw on unhandled 'error' event" behavior takes
      // the whole process down (verified manually: this exact loop crashes
      // with `Error: write ECONNRESET ... Emitted 'error' event on Socket
      // instance` when no listener is attached).
      const netServer = createNetServer();
      server = netServer;

      let ignoredErrorCode: string | null = null;
      installClientGoneSocketGuard(netServer, (err) => {
        ignoredErrorCode = err.code ?? null;
      });

      let uncaught: unknown = null;
      uncaughtExceptionHandler = (err) => {
        uncaught = err;
      };
      process.on("uncaughtException", uncaughtExceptionHandler as NodeJS.UncaughtExceptionListener);

      const guardObserved = new Promise<void>((resolve) => {
        netServer.on("connection", (socket: Socket) => {
          setImmediate(function tryWrite(attemptsLeft = 200) {
            if (ignoredErrorCode || attemptsLeft <= 0) {
              resolve();
              return;
            }
            socket.write(Buffer.alloc(65536, 1));
            setImmediate(() => tryWrite(attemptsLeft - 1));
          });
        });
      });

      await new Promise<void>((resolve) => netServer.listen(0, "127.0.0.1", resolve));
      const address = netServer.address();
      if (!address || typeof address === "string") {
        throw new Error("expected a TCP address");
      }

      const client = connect(address.port, "127.0.0.1", () => {
        client.resetAndDestroy();
      });
      client.on("error", () => {
        // Client-side errors from the reset are expected and irrelevant here.
      });

      await guardObserved;

      expect(uncaught).toBeNull();
      // Linux reports ECONNRESET for a write after an RST; other platforms
      // (e.g. macOS/BSD) can surface EPIPE for the same condition — both are
      // client-gone codes the guard must swallow either way.
      expect(["EPIPE", "ECONNRESET"]).toContain(ignoredErrorCode);
    },
    5000,
  );

  it("rethrows a non-client-gone error when it is the only listener on the socket, preserving crash-on-real-bug behavior", () => {
    const netServer = createNetServer();
    server = netServer;

    const onIgnored = () => {
      throw new Error("onIgnored must not be called for a non-client-gone error");
    };
    installClientGoneSocketGuard(netServer, onIgnored);

    let capturedSocket: Socket | null = null;
    netServer.on("connection", (socket: Socket) => {
      capturedSocket = socket;
    });

    // Drive a real connection so the guard's 'connection' listener actually
    // attaches to a real socket, then inject a non-client-gone error the
    // same way Node's own internals would: emit('error', ...) on the socket.
    return new Promise<void>((resolve, reject) => {
      netServer.listen(0, "127.0.0.1", () => {
        const address = netServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("expected a TCP address"));
          return;
        }
        const client = connect(address.port, "127.0.0.1", () => {
          setImmediate(() => {
            try {
              if (!capturedSocket) throw new Error("server never observed the connection");
              // The guard is the ONLY 'error' listener here — this is the
              // condition under which it must still rethrow (matching what
              // Node would have done with no guard installed at all).
              expect((capturedSocket as Socket).listenerCount("error")).toBe(1);
              const otherError = Object.assign(new Error("permission denied"), { code: "EACCES" });
              expect(() => (capturedSocket as Socket).emit("error", otherError)).toThrow("permission denied");
              resolve();
            } catch (err) {
              reject(err as Error);
            } finally {
              // Always tear down the client, including on assertion failure —
              // otherwise afterEach's server.close() hangs on the still-open
              // connection and masks the real failure with a timeout.
              client.destroy();
            }
          });
        });
        client.on("error", () => {
          // Destroying the client after the assertion above can itself
          // surface a benign client-side error; ignore it here.
        });
      });
    });
  });

  it("defers to another listener instead of throwing when one is already attached to the socket", () => {
    // Reproduces the scenario both review passes flagged: a socket that is
    // guarded here AND separately guarded elsewhere (e.g. the WebSocket
    // upgrade path in realtime/live-events-ws.ts, or any future route-level
    // handler). The guard must not steal or interrupt that other listener's
    // chance to run by throwing first — see socket-guard.ts's listenerCount
    // check.
    const netServer = createNetServer();
    server = netServer;

    installClientGoneSocketGuard(netServer);

    let capturedSocket: Socket | null = null;
    const downstreamReceived: unknown[] = [];
    netServer.on("connection", (socket: Socket) => {
      capturedSocket = socket;
      // Registered AFTER the guard's own listener (installClientGoneSocketGuard
      // ran first, via the 'connection' listener it attached before this
      // one), simulating a second, independent consumer of this socket's
      // 'error' event.
      socket.on("error", (err: Error) => {
        downstreamReceived.push(err);
      });
    });

    return new Promise<void>((resolve, reject) => {
      netServer.listen(0, "127.0.0.1", () => {
        const address = netServer.address();
        if (!address || typeof address === "string") {
          reject(new Error("expected a TCP address"));
          return;
        }
        const client = connect(address.port, "127.0.0.1", () => {
          setImmediate(() => {
            try {
              if (!capturedSocket) throw new Error("server never observed the connection");
              expect((capturedSocket as Socket).listenerCount("error")).toBe(2);
              const otherError = Object.assign(new Error("permission denied"), { code: "EACCES" });
              // Must NOT throw: the guard steps back since it isn't alone.
              expect(() => (capturedSocket as Socket).emit("error", otherError)).not.toThrow();
              expect(downstreamReceived).toEqual([otherError]);
              resolve();
            } catch (err) {
              reject(err as Error);
            } finally {
              // Always tear down the client, including on assertion failure —
              // otherwise afterEach's server.close() hangs on the still-open
              // connection and masks the real failure with a timeout.
              client.destroy();
            }
          });
        });
        client.on("error", () => {
          // Destroying the client after the assertion above can itself
          // surface a benign client-side error; ignore it here.
        });
      });
    });
  });
});
