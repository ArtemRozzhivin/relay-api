import type { HttpStatus } from '@nestjs/common';
import { ApiHeader, ApiResponse } from '@nestjs/swagger';
import { z, type ZodType } from 'zod';

/** A `Date` as JSON carries it. */
export const instant = z.iso.datetime();

/** A page of a list read with a cursor (D14). */
export const page = <T extends ZodType>(item: T) =>
  z
    .object({ items: z.array(item), nextCursor: z.string().nullable() })
    .strict();

/**
 * A success as the client receives it: the route's data inside the envelope
 * `ResponseEnvelopeInterceptor` puts every answer in (§6.1).
 */
export const succeeded = <T extends ZodType>(data: T) =>
  z.object({ success: z.literal(true), data, requestId: z.string() }).strict();

/** A failure as the client receives it, from `DomainExceptionFilter` (§6.1). */
export const failed = z
  .object({
    success: z.literal(false),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.unknown().optional(),
      })
      .strict(),
    requestId: z.string(),
  })
  .strict();

/**
 * Documents a route's success: its status, and what its `data` holds. The
 * same schema checks the route's real answers in the tests, so the document
 * cannot describe a response the route does not give.
 */
export const ApiData = (
  status: HttpStatus,
  data: ZodType,
  description: string,
) => ApiResponse({ status, description, standardSchema: succeeded(data) });

/** Documents the header a route that starts work requires (§7.2). */
export const ApiIdempotencyKey = () =>
  ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description:
      'Yours to choose, once per piece of work: the same key again answers with what the first request made. Not beginning with `pipeline:`',
  });
