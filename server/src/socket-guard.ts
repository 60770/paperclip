import type { Socket } from "node:net";

/**
 * Minimal structural type for "something that emits 'connection' with the
 * raw accepted socket" — satisfied by both node:http's Server and node:net's
 * Server (http.Server extends net.Server and inherits this event). Kept
 * narrow on purpose so this doesn't couple to http.Server's full, heavily
 * overloaded `.on()` signature.
 */
interface ConnectionEmitter {
  on(event: "connection", listener: (socket: Socket) => void): unknown;
}

/**
 * Error codes that mean "the remote peer is gone" rather than "something is
 * actually wrong": the client closed its end of the connection (process
 * exited, piped consumer like `grep -q`/`head -1` closed stdout, browser
 * navigated away, etc.) before or while we were writing the response.
 *
 * - EPIPE: we wrote to a socket whose read side the peer already closed.
 * - ECONNRESET: the peer tore the connection down with an RST.
 */
const CLIENT_GONE_ERROR_CODES = new Set(["EPIPE", "ECONNRESET"]);

export function isClientGoneSocketError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof (err as NodeJS.ErrnoException).code === "string" &&
    CLIENT_GONE_ERROR_CODES.has((err as NodeJS.ErrnoException).code as string)
  );
}

/**
 * Installs a permanent 'error' listener on every TCP connection the server
 * accepts, so a client that disconnects mid-response can never crash the
 * process with an unhandled 'error' event on the socket (see GOT-2091:
 * `Error: write EPIPE ... Emitted 'error' event on Socket instance`,
 * unhandled, taking the whole process down).
 *
 * Why here (server 'connection' event) and not per-request:
 * attaching once per accepted socket, at connection time, guarantees the
 * socket always has at least one 'error' listener for its entire lifetime —
 * regardless of how many keep-alive requests it serves, whether it's later
 * upgraded to a WebSocket, or how Node's own internal bookkeeping happens to
 * add/remove its own listeners. There is never a window with zero listeners,
 * which is the only condition under which Node's default "throw on unhandled
 * 'error'" behavior can fire. This mirrors the guard already used for the
 * raw WebSocket upgrade socket in realtime/live-events-ws.ts.
 *
 * Client-gone codes (EPIPE/ECONNRESET) are always swallowed — they are
 * expected under normal operation and never indicate a bug.
 *
 * Any other error is rethrown, but ONLY if this is the sole 'error' listener
 * on the socket at the time it fires. If something else is also listening
 * (e.g. a WebSocket upgrade handler's own guard, or a future route-level
 * handler), we step back and let it run instead of pre-empting it — a
 * listener that throws stops the remaining listeners in that emit() from
 * running at all, which would silently break whatever cleanup/handling they
 * were doing. When we really are the only listener, rethrowing reproduces
 * the same "unhandled 'error' event" crash Node would have produced with no
 * guard installed at all, so real bugs still fail loud instead of being
 * silently swallowed.
 */
export function installClientGoneSocketGuard(
  server: ConnectionEmitter,
  onIgnored?: (err: NodeJS.ErrnoException, socket: Socket) => void,
): void {
  server.on("connection", (socket: Socket) => {
    socket.on("error", (err: Error) => {
      if (isClientGoneSocketError(err)) {
        onIgnored?.(err, socket);
        return;
      }
      if (socket.listenerCount("error") === 1) {
        throw err;
      }
      // Another listener is also attached to this socket; defer to it
      // instead of throwing out from under it.
    });
  });
}
