/**
 * Anything a `catch` received, as text for a log line: an `Error`'s message,
 * or the value itself when something other than an `Error` was thrown.
 *
 * An `AggregateError` with no message of its own — what Node throws when it
 * has tried every address of a host and none answered — is described by the
 * errors it holds, each once.
 */
export const describeError = (error: unknown): string => {
  if (error instanceof AggregateError && !error.message) {
    return [...new Set(error.errors.map(describeError))].join('; ');
  }

  return error instanceof Error ? error.message : String(error);
};
