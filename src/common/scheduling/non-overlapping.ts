/**
 * Wraps a task a timer calls on an interval.
 *
 * A call made while the previous run is still going returns at once, so a run
 * slower than its interval is skipped rather than stacked on top of. The
 * returned function never rejects: a timer awaits nothing, so a rejection
 * would be unhandled and take the process down. A failure goes to `onError`,
 * and the next call runs as usual.
 */
export const nonOverlapping = (
  task: () => Promise<unknown>,
  onError: (error: unknown) => void,
) => {
  let running = false;

  return async () => {
    if (running) {
      return;
    }

    running = true;

    try {
      await task();
    } catch (error) {
      onError(error);
    } finally {
      running = false;
    }
  };
};
