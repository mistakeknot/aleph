const LOG_TRANSPORT_FAILURE_MESSAGES = new Set([
  "_flushSync failed",
  "_flushSync took too long (10s)",
  "end() failed",
  "end() took too long (10s)",
  "the worker has exited",
  "the worker thread exited",
  "the worker is ending",
]);

/**
 * True for the errors thread-stream raises once its worker thread has died
 * (disk full, I/O error, worker exit). They surface in places the logger
 * cannot wrap: a setImmediate flush and the process exit handler.
 */
export function isLogTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (LOG_TRANSPORT_FAILURE_MESSAGES.has(error.message)) {
    return true;
  }
  return (
    error instanceof RangeError &&
    (error as { code?: unknown }).code === "ERR_OUT_OF_RANGE" &&
    typeof error.stack === "string" &&
    error.stack.includes("thread-stream")
  );
}

