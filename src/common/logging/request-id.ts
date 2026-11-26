import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// A caller's id is logged, stored on every job the request submits and shown
// back to the job's owner, so only one shaped like an id is kept: a UUID, a
// ULID, a trace id. A header of kilobytes, or one with a line break or markup
// in it, gets an id of ours instead.
const CALLERS_ID = /^[\w.:-]{1,128}$/;

/**
 * Gives a request its id — the caller's `X-Request-Id` when it sent one of up
 * to 128 letters, digits and `_.:-`, a new UUID otherwise — on `req.id`, where
 * the logs, the job's `correlationId` and an error response read it, and in
 * the response's `X-Request-Id` header.
 *
 * Runs twice: first thing on the edge, so a request the body parser rejects
 * still has an id, and again as pino-http's `genReqId`. The second call keeps
 * the first one's id.
 *
 * @returns the request's id.
 */
export const assignRequestId = (req: IncomingMessage, res: ServerResponse) => {
  // pino-http types `id` as always present; before either call it is not.
  const assigned = req.id as IncomingMessage['id'] | undefined;

  if (assigned !== undefined) {
    return assigned;
  }

  const inbound = req.headers['x-request-id'];
  const id =
    typeof inbound === 'string' && CALLERS_ID.test(inbound)
      ? inbound
      : randomUUID();

  req.id = id;
  res.setHeader('X-Request-Id', id);

  return id;
};
