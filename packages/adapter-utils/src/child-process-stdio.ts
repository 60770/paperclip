import type { ChildProcess } from "node:child_process";

export type ChildProcessStdioStream = "stdin" | "stdout" | "stderr";

export interface ChildProcessStdioError {
  error: Error;
  stream: ChildProcessStdioStream;
}

export interface ChildProcessStdioGuard {
  handleError: (stream: ChildProcessStdioStream, error: Error) => void;
  dispose: () => void;
}

const PEER_CLOSED_ERROR_CODES = new Set(["EPIPE", "ECONNRESET"]);

export function isChildProcessStdioPeerClosedError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    PEER_CLOSED_ERROR_CODES.has((error as NodeJS.ErrnoException).code as string)
  );
}

export function installChildProcessStdioErrorHandlers(
  child: ChildProcess,
  options: {
    onPeerClosed?: (event: ChildProcessStdioError) => void;
    onUnexpectedError: (event: ChildProcessStdioError) => void;
  },
): ChildProcessStdioGuard {
  const handleError = (stream: ChildProcessStdioStream, error: Error) => {
    try {
      if (isChildProcessStdioPeerClosedError(error)) {
        options.onPeerClosed?.({ error, stream });
        return;
      }
      options.onUnexpectedError({ error, stream });
    } catch (handlerError) {
      console.error("Child process stdio error handler failed", handlerError);
    }
  };

  const listeners: Array<{
    stream: NonNullable<ChildProcess[ChildProcessStdioStream]>;
    listener: (error: Error) => void;
  }> = [];

  for (const streamName of ["stdin", "stdout", "stderr"] as const) {
    const stream = child[streamName];
    if (!stream) continue;
    const listener = (error: Error) => handleError(streamName, error);
    stream.on("error", listener);
    listeners.push({ stream, listener });
  }

  return {
    handleError,
    dispose: () => {
      for (const { stream, listener } of listeners) {
        stream.off("error", listener);
      }
    },
  };
}
