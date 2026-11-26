import { expect } from 'vitest';
import type {
  Prisma,
  PrismaClient,
} from '../../src/generated/prisma/client.js';
import { lockAccount } from '../../src/prisma/account-lock.js';

// Whether some connection is waiting on a lock the backend `pid` holds,
// asked until one is or the time runs out.
const blockedBehind = async (prisma: PrismaClient, pid: number) => {
  const deadline = Date.now() + 3_000;

  while (Date.now() < deadline) {
    const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE ${pid}::int = ANY (pg_blocking_pids(pid))`;

    if (waiting > 0) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return false;
};

/**
 * Plays the other of two requests racing for an account's last place (D32).
 * A limit is a count and then a write, and two requests overlapping between
 * them could both take one free place; fired together they never overlap,
 * each transaction lasting a couple of milliseconds. So this takes the
 * account's lock, fills the last place with `fill`, and holds its transaction
 * open while `send` makes the request under test. That request must be seen
 * waiting behind it — the only thing the two share is the lock — and, let
 * through, must find the place taken.
 *
 * @returns what `send` resolved to.
 */
export const whileLastPlaceIsTaken = async <T>(
  prisma: PrismaClient,
  userId: string,
  fill: (tx: Prisma.TransactionClient) => Promise<unknown>,
  send: () => Promise<T>,
) => {
  let filled!: (pid: number) => void;
  let release!: () => void;
  const placeFilled = new Promise<number>((resolve) => (filled = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));

  const other = prisma.$transaction(
    async (tx) => {
      await lockAccount(tx, userId);
      const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`;
      await fill(tx);
      filled(pid);
      await released;
    },
    { timeout: 10_000 },
  );

  const holder = await placeFilled;
  const answer = send();
  const waited = await blockedBehind(prisma, holder);
  release();
  await other;

  expect(waited, 'the request never waited for the account lock').toBe(true);

  return answer;
};
