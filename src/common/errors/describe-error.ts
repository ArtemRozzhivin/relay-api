/**
 * Anything a `catch` received, as text for a log line: an `Error`'s message,
 * or the value itself when something other than an `Error` was thrown.
 */
export const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
