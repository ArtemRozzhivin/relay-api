import type { Prisma } from '../../generated/prisma/client.js';
import { TooManyUnfinishedJobsError } from '../../common/errors/app-error.js';
import type { JobType } from '../jobs.schema.js';
import { UNFINISHED_STATUSES } from '../engine/job-statuses.js';

/**
 * How many jobs of a type one account can have queued or running at once
 * (D32): the types whose work costs money, or holds a queue every account
 * shares. `MOCK` and `CHARGE` are bounded by the submit rate alone.
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
  // The AI queue runs 20 a minute for every account together, first come
  // first served: ten is half a minute of it, so one account's backlog never
  // holds the others' work back for longer than that.
  ['ai.enrich', 10],
]);

// The jobs a cap counts. Not a pipeline's batch still holding its place: a
// pipeline is limited as a whole, one running per account, and counting its
// batches would refuse its owner's own submits — and the re-drive of a failed
// batch of that same pipeline — until they drained (§6.3e). Its import counts
// like any import, and a batch re-driven after its first finish like any job.
const COUNTED: Prisma.JobWhereInput = {
  status: { in: UNFINISHED_STATUSES },
  OR: [{ pendingInPipeline: false }, { type: 'import.csv' }],
};

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
    where: { userId, type, ...COUNTED },
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
      type: { in: [...UNFINISHED_CAPS.keys()] },
      ...COUNTED,
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
