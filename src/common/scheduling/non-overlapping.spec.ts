import { describe, expect, it } from 'vitest';
import { nonOverlapping } from './non-overlapping.js';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
};

describe('nonOverlapping', () => {
  it('skips a call made while the previous run is still going', async () => {
    const run = deferred();
    let started = 0;
    const tick = nonOverlapping(
      () => {
        started += 1;

        return run.promise;
      },
      () => {},
    );

    const first = tick();
    await tick();

    expect(started).toBe(1);

    run.resolve();
    await first;
  });

  it('runs again once the previous run has finished', async () => {
    let started = 0;
    const tick = nonOverlapping(
      async () => {
        started += 1;
      },
      () => {},
    );

    await tick();
    await tick();

    expect(started).toBe(2);
  });

  // A failed run that left the guard set would stop the timer's work for good,
  // with nothing in the log after the one failure.
  it('hands a failure to onError, resolves, and runs on the next call', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const tick = nonOverlapping(
      async () => {
        calls += 1;

        if (calls === 1) {
          throw new Error('redis is down');
        }
      },
      (error) => errors.push(error),
    );

    await expect(tick()).resolves.toBeUndefined();
    await tick();

    expect(errors).toEqual([new Error('redis is down')]);
    expect(calls).toBe(2);
  });
});
