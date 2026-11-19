import type { Prisma } from '../generated/prisma/client.js';
import type { JobStatus } from '../generated/prisma/enums.js';
import { TooManyUnfinishedJobsError } from '../common/errors/app-error.js';
import type { JobType } from './jobs.schema.js';

/**
 * How many jobs of a type one account can have queued or running at once
 * (D32). Only the types whose work reads or writes the bucket; the others are
 * bounded by the submit rate alone.
 */
export const UNFINISHED_CAPS: ReadonlyMap<string, number> = new Map<
  JobType,
  number
>([
  // Each holds one download of up to 50 MB, and a store imports one catalog
  // at a time.
  ['import.csv', 3],
  // 2 500 products in flight; a larger catalog sends its next batch as one
  // finishes.
  ['image.process', 50],
]);

const UNFINISHED: JobStatus[] = ['QUEUED', 'RUNNING'];

/** Whether a job of this type counts against a cap, and so needs `lockAccount` before it is written. */
export const isCapped = (type: string) => UNFINISHED_CAPS.has(type);

/**
 * Refuses a job just written, or just re-driven, that takes its account past
 * its type's cap. Called after the write and under `lockAccount`, so the count
 * includes that job and nothing else of the account's is written in between;
 * the throw rolls the write back. Does nothing for a type without a cap.
 *
 * @throws TooManyUnfinishedJobsError (429).
 */
export const assertUnderCap = async (
  tx: Prisma.TransactionClient,
  userId: string,
  type: string,
) => {
  const cap = UNFINISHED_CAPS.get(type);

  if (cap === undefined) {
    return;
  }

  const unfinished = await tx.job.count({
    where: { userId, type, status: { in: UNFINISHED } },
  });

  if (unfinished > cap) {
    throw new TooManyUnfinishedJobsError(type, cap);
  }
};

/**
 * How many more jobs of each capped type the account can have unfinished.
 * Read under `lockAccount`, or it is stale by the time it is used.
 */
export const roomLeft = async (
  tx: Prisma.TransactionClient,
  userId: string,
) => {
  const counts = await tx.job.groupBy({
    by: ['type'],
    where: {
      userId,
      status: { in: UNFINISHED },
      type: { in: [...UNFINISHED_CAPS.keys()] },
    },
    _count: { _all: true },
  });
  const room = new Map(UNFINISHED_CAPS);

  for (const { type, _count } of counts) {
    room.set(type, (room.get(type) ?? 0) - _count._all);
  }

  return room;
};

/**
 * The jobs, in their order, that fit: a capped type's are kept until its room
 * runs out, and the rest of that type are left out. Types without a cap are
 * always kept.
 */
export const withinRoom = <T extends { type: string }>(
  jobs: readonly T[],
  room: ReadonlyMap<string, number>,
) => {
  const left = new Map(room);

  return jobs.filter(({ type }) => {
    const places = left.get(type);

    if (places === undefined) {
      return true;
    }

    left.set(type, places - 1);

    return places > 0;
  });
};
