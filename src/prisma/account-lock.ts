import type { Prisma } from '../generated/prisma/client.js';

// The first half of the lock's key: a lock some later feature takes on its own
// key space can then never wait on these by accident.
const ACCOUNT_CAPS = 1;

/**
 * Holds the account's lock until the transaction ends, so a count of what the
 * account has and the write that depends on it happen as one step (D32): two
 * requests that each see one free place cannot both take it. Other accounts
 * never wait on it. Commit or rollback releases it; there is no unlock.
 *
 * Needs READ COMMITTED, Postgres's default: each statement after the lock
 * then sees what the previous holder committed. Under REPEATABLE READ the
 * snapshot is taken by the lock's own statement, before the wait, and a count
 * after it would miss that holder's write.
 */
export const lockAccount = (tx: Prisma.TransactionClient, userId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(${ACCOUNT_CAPS}::int, hashtext(${userId}::text))`;
