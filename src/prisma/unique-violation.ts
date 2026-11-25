import { Prisma } from '../generated/prisma/client.js';

/**
 * Whether a write was refused because a row with the same unique key already
 * exists (Prisma's P2002). Every place that writes "at most once" — a
 * registration, a submit's idempotency key, a charge's effect key — relies on
 * that refusal, and reads it here.
 */
export const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === 'P2002';
