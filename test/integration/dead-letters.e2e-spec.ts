import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import type { JobStatus } from '../../src/generated/prisma/enums.js';
import type { DeadLetterCode } from '../../src/jobs/job-error-codes.js';
import { registerAndLogin, startApp } from '../support/http.js';
import { deleteUsers, seedJob } from '../support/db.js';

// The list is read to decide what to re-drive, so it has to show what a
// re-drive with the same filter would take, in the order it would take it.
describe('GET /jobs/dead-letters', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  const users: string[] = [];

  const tenant = async (label: string) => {
    const account = await registerAndLogin(server, `dead-${label}`);

    users.push(account.userId);

    return account;
  };

  // Rows are written directly: what is under test is which rows the list
  // shows, not how a job comes to die.
  const job = async (
    userId: string,
    {
      status = 'DEAD_LETTERED' as JobStatus,
      code = 'ATTEMPTS_EXHAUSTED' as DeadLetterCode,
      type = 'MOCK',
      finishedAt = new Date('2026-11-18T02:30:00Z') as Date | null,
      createdAt = new Date('2026-11-18T01:00:00Z'),
    } = {},
  ) => {
    const created = await seedJob(prisma, {
      userId,
      type,
      payload: { durationMs: 10 },
      status,
      attempts: 3,
      error: { code, message: 'it died', attempt: 3 },
      checkpoint: { row: 40 },
      finishedAt,
      createdAt,
    });

    return created.id;
  };

  const died = (time: string) => new Date(`2026-11-18T${time}Z`);

  const list = (token: string, query = '') =>
    request(server)
      .get(`/jobs/dead-letters${query}`)
      .set('Authorization', `Bearer ${token}`);

  const idsOn = (body: { data: { items: { id: string }[] } }) =>
    body.data.items.map(({ id }) => id);

  // Follows nextCursor to the end, one page's ids per entry. Stops after
  // `most` pages: a cursor that does not advance would otherwise loop for
  // ever instead of failing.
  const pagesOf = async (token: string, limit: number, most = 20) => {
    const pages: string[][] = [];
    let cursor: string | null = null;

    do {
      const query = new URLSearchParams({ limit: String(limit) });

      if (cursor) {
        query.set('cursor', cursor);
      }

      const { status, body } = await list(token, `?${query}`);

      expect(status).toBe(200);
      pages.push(idsOn(body));
      cursor = body.data.nextCursor;
    } while (cursor && pages.length < most);

    expect(cursor, 'the cursor never reached the end').toBeNull();

    return pages;
  };

  // The order the list promises, read straight from the table.
  const deadLettersInOrder = async (userId: string) =>
    (
      await prisma.job.findMany({
        where: { userId, status: 'DEAD_LETTERED' },
        orderBy: [{ finishedAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      })
    ).map(({ id }) => id);

  beforeAll(async () => {
    ({ app, server } = await startApp());
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await app.close();
  });

  it("lists only the caller's own dead letters, as the job list shows a job", async () => {
    const { token, userId } = await tenant('own');
    const deadLetter = await job(userId);

    await job(userId, { status: 'QUEUED', finishedAt: null });
    await job(userId, { status: 'RUNNING', finishedAt: null });
    await job(userId, { status: 'SUCCEEDED' });
    await job(userId, { status: 'CANCELLED' });

    const other = await tenant('own-other');

    await job(other.userId);

    const { status, body } = await list(token);

    expect(status).toBe(200);
    expect(body.data.nextCursor).toBeNull();
    expect(idsOn(body)).toEqual([deadLetter]);

    const [item] = body.data.items;

    expect(item).toMatchObject({
      status: 'DEAD_LETTERED',
      error: { code: 'ATTEMPTS_EXHAUSTED', message: 'it died' },
      finishedAt: '2026-11-18T02:30:00.000Z',
    });
    expect(item).not.toHaveProperty('lease');
    expect(item).not.toHaveProperty('checkpoint');
    expect(item).not.toHaveProperty('requestHash');
  });

  it('narrows by error code and by type', async () => {
    const { token, userId } = await tenant('narrow');
    const abandoned = await job(userId, {
      code: 'DELIVERY_ABANDONED',
      finishedAt: died('02:01:00'),
    });
    const exhaustedMock = await job(userId, { finishedAt: died('02:02:00') });
    const exhaustedCharge = await job(userId, {
      type: 'CHARGE',
      finishedAt: died('02:03:00'),
    });

    const byCode = await list(token, '?errorCode=ATTEMPTS_EXHAUSTED');
    const byType = await list(token, '?type=CHARGE');
    const both = await list(token, '?errorCode=DELIVERY_ABANDONED&type=MOCK');

    expect(idsOn(byCode.body)).toEqual([exhaustedMock, exhaustedCharge]);
    expect(idsOn(byType.body)).toEqual([exhaustedCharge]);
    expect(idsOn(both.body)).toEqual([abandoned]);
  });

  // Half-open, as the re-drive's window is.
  it('treats the window as from-inclusive and to-exclusive', async () => {
    const { token, userId } = await tenant('window');

    await job(userId, { finishedAt: died('01:59:59') });
    const atStart = await job(userId, { finishedAt: died('02:00:00') });
    const inside = await job(userId, { finishedAt: died('02:59:59') });
    await job(userId, { finishedAt: died('03:00:00') });

    const { body } = await list(
      token,
      '?deadLetteredFrom=2026-11-18T02:00:00Z&deadLetteredTo=2026-11-18T03:00:00Z',
    );

    expect(idsOn(body)).toEqual([atStart, inside]);
  });

  // A query string reads an unencoded + as a space, so an offset has to be
  // sent as %2B.
  it('reads an encoded offset as the instant it names', async () => {
    const { token, userId } = await tenant('offset');
    const deadLetter = await job(userId, { finishedAt: died('02:30:00') });

    // 04:00+02:00 is 02:00Z, so the window covers 02:30Z.
    const { body } = await list(
      token,
      '?deadLetteredFrom=2026-11-18T04:00:00%2B02:00&deadLetteredTo=2026-11-18T05:00:00%2B02:00',
    );

    expect(idsOn(body)).toEqual([deadLetter]);
  });

  it('pages oldest-dead first, every dead letter once, through jobs that died in the same millisecond', async () => {
    const { token, userId } = await tenant('order');
    const tie = died('02:00:00');
    // Created in the opposite order to their deaths, so an order taken from
    // createdAt would show.
    const deaths = [
      died('01:00:00'),
      tie,
      tie,
      tie,
      tie,
      died('03:00:00'),
      died('04:00:00'),
    ];

    for (const [index, finishedAt] of deaths.entries()) {
      await job(userId, {
        finishedAt,
        createdAt: new Date(Date.UTC(2026, 10, 18, 0, 59 - index)),
      });
    }

    const pages = await pagesOf(token, 2);

    expect(pages.map((page) => page.length)).toEqual([2, 2, 2, 1]);
    expect(pages.flat()).toEqual(await deadLettersInOrder(userId));
  });

  // Written with microseconds, as now() would write them, the column keeps
  // milliseconds, so the cursor's value is the row's own. At microseconds a
  // page would start before the dead letter the last one ended on.
  it('shows nothing twice when deaths are closer than a millisecond', async () => {
    const { token, userId } = await tenant('microseconds');

    for (let index = 0; index < 3; index += 1) {
      await job(userId);
    }

    // 02:00:00.123100, .123200 and .123300.
    await prisma.$executeRaw`
      UPDATE "Job" SET "finishedAt" =
        timestamptz '2026-11-18 02:00:00.123+00' + ranked.n * interval '100 microseconds'
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS n
            FROM "Job" WHERE "userId" = ${userId}::uuid) AS ranked
      WHERE "Job".id = ranked.id`;

    const pages = await pagesOf(token, 1);

    expect(pages.flat()).toHaveLength(3);
    expect(new Set(pages.flat()).size).toBe(3);
  });

  it('keeps its place when the dead letter a page ended on is re-driven', async () => {
    const { token, userId } = await tenant('re-driven');
    const deadLetters: string[] = [];

    for (const hour of [1, 2, 3, 4]) {
      deadLetters.push(
        await job(userId, { finishedAt: died(`0${hour}:00:00`) }),
      );
    }

    const first = await list(token, '?limit=2');

    // Re-driven from the page just read: the row the cursor ended on is no
    // longer a dead letter, and the next page must still start after it.
    await request(server)
      .post(`/jobs/${deadLetters[1]}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .expect(202);

    const second = await list(
      token,
      `?limit=2&cursor=${first.body.data.nextCursor}`,
    );

    expect(idsOn(first.body)).toEqual(deadLetters.slice(0, 2));
    expect(idsOn(second.body)).toEqual(deadLetters.slice(2));
  });

  // Ten dead letters that died in one millisecond: only the id orders them.
  // A re-drive ordered any other way would take a different five.
  it('shows first the batch a re-drive with the same filter and limit takes', async () => {
    const { token, userId } = await tenant('batch');

    for (let index = 0; index < 10; index += 1) {
      await job(userId, { finishedAt: died('02:00:00') });
    }

    const shown = await list(token, '?type=MOCK&limit=5');

    const { body } = await request(server)
      .post('/jobs/retry')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'MOCK', limit: 5 })
      .expect(202);

    // Read as "no longer dead", not as QUEUED: a worker running alongside
    // the tests may already have taken them.
    const redriven = await prisma.job.findMany({
      where: { userId, status: { not: 'DEAD_LETTERED' } },
      select: { id: true },
    });

    expect(body.data).toEqual({ redriven: 5, remaining: 5 });
    expect(new Set(redriven.map(({ id }) => id))).toEqual(
      new Set(idsOn(shown.body)),
    );
  });

  it.each([
    [
      'a window that ends before it starts',
      'deadLetteredFrom=2026-11-18T03:00:00Z&deadLetteredTo=2026-11-18T02:00:00Z',
    ],
    ['a time without a timezone', 'deadLetteredFrom=2026-11-18T02:00:00'],
    // The + arrives as a space.
    [
      'an offset whose + is not encoded',
      'deadLetteredFrom=2026-11-18T04:00:00+02:00',
    ],
    ['an error code no job dies with', 'errorCode=ATTEMPT_FAILED'],
    ['a re-drive option', 'dryRun=true'],
    [
      "the job list's cursor",
      `cursor=${Buffer.from(
        JSON.stringify({
          createdAt: '2026-11-18T02:00:00.000Z',
          id: randomUUID(),
        }),
      ).toString('base64url')}`,
    ],
  ])('refuses %s with a 400', async (_label, query) => {
    const { token } = await tenant('bad-query');

    await list(token, `?${query}`).expect(400);
  });

  // A dead letter without one would sort last, end a page on a value the
  // cursor cannot carry, and be re-driven without ever being listed.
  it('cannot hold a dead letter without the time it died, even written directly', async () => {
    const { userId } = await tenant('no-finished-at');

    await expect(job(userId, { finishedAt: null })).rejects.toThrow(
      'Job_finished_at_exactly_when_finished',
    );
  });

  // The other half of the same rule: "has a finishedAt" and "is finished" are
  // one fact, so nothing can read a finish time off a job still in flight.
  it.each(['QUEUED', 'RUNNING'] as const)(
    'cannot hold a %s job with a time it finished, even written directly',
    async (status) => {
      const { userId } = await tenant('unfinished-finished-at');

      await expect(
        job(userId, { status, finishedAt: died('02:00:00') }),
      ).rejects.toThrow('Job_finished_at_exactly_when_finished');
    },
  );

  it('refuses a caller with no token', async () => {
    await request(server).get('/jobs/dead-letters').expect(401);
  });
});
