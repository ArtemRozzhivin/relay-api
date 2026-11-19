import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { registerAndLogin, startApp } from '../support/http.js';
import { deleteUsers, seedJob } from '../support/db.js';

// What a cursor has to get right that an offset does not: every row exactly
// once, however the list changes while a client is part-way through it (D14).
describe('cursor pagination', () => {
  let app: INestApplication;
  let server: Server;
  let prisma: PrismaService;
  const users: string[] = [];

  const register = async (label: string) => {
    const account = await registerAndLogin(server, `page-${label}`);

    users.push(account.userId);

    return account;
  };

  const get = (token: string, path: string) =>
    request(server).get(path).set('Authorization', `Bearer ${token}`);

  // Follows nextCursor until it is null, recording each page.
  const pagesOf = async (
    token: string,
    path: string,
    limit: number,
    from: string | null = null,
  ) => {
    const pages: { id: string; sku?: string }[][] = [];
    let cursor = from;

    do {
      const query = new URLSearchParams({ limit: String(limit) });

      if (cursor) {
        query.set('cursor', cursor);
      }

      const separator = path.includes('?') ? '&' : '?';
      const { status, body } = await get(token, `${path}${separator}${query}`);

      expect(status).toBe(200);
      pages.push(body.data.items);
      cursor = body.data.nextCursor;
    } while (cursor);

    return pages;
  };

  const jobsFor = (userId: string, createdAt: Date[]) =>
    Promise.all(
      createdAt.map((at) => seedJob(prisma, { userId, createdAt: at })),
    );

  // The order the list promises, read straight from the table.
  const jobIdsInOrder = async (userId: string) =>
    (
      await prisma.job.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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

  describe('GET /jobs', () => {
    it('returns every job once, newest first, through equal timestamps', async () => {
      const { token, userId } = await register('ties');
      const tie = new Date('2026-11-01T10:00:00.000Z');

      // Four jobs in one millisecond: only the id can order them, and a page
      // boundary falls among them.
      await jobsFor(userId, [
        new Date('2026-11-01T09:00:00.000Z'),
        tie,
        tie,
        tie,
        tie,
        new Date('2026-11-01T11:00:00.000Z'),
        new Date('2026-11-01T12:00:00.000Z'),
      ]);

      const pages = await pagesOf(token, '/jobs', 2);

      expect(pages.map((page) => page.length)).toEqual([2, 2, 2, 1]);
      expect(pages.flat().map(({ id }) => id)).toEqual(
        await jobIdsInOrder(userId),
      );
    });

    // Postgres's clock is finer than a JS Date. Written with microseconds,
    // as now() would write them, the column keeps only milliseconds — so the
    // cursor, which carries the value through JavaScript, compares exactly.
    it('loses no job to a clock finer than the cursor', async () => {
      const { token, userId } = await register('microseconds');
      const jobs = await jobsFor(userId, [new Date(), new Date(), new Date()]);

      await prisma.$executeRaw`
        UPDATE "Job" SET "createdAt" = CASE id
          WHEN ${jobs[0]!.id}::uuid THEN timestamptz '2026-11-01 10:00:00.123100+00'
          WHEN ${jobs[1]!.id}::uuid THEN timestamptz '2026-11-01 10:00:00.123200+00'
          ELSE timestamptz '2026-11-01 10:00:00.123300+00' END
        WHERE "userId" = ${userId}::uuid`;

      const pages = await pagesOf(token, '/jobs', 1);

      expect(pages.flat().map(({ id }) => id)).toEqual(
        await jobIdsInOrder(userId),
      );
      expect(pages.flat()).toHaveLength(3);
    });

    it('shows nothing twice when a job is submitted mid-scroll', async () => {
      const { token, userId } = await register('mid-scroll');
      const seeded = await jobsFor(
        userId,
        [1, 2, 3, 4, 5].map((hour) => new Date(`2026-11-01T0${hour}:00:00Z`)),
      );

      const first = await get(token, '/jobs?limit=2');

      // Newer than everything listed: with an offset it would push the
      // second job of the first page onto the start of the second.
      await jobsFor(userId, [new Date()]);

      const rest = await pagesOf(token, '/jobs', 2, first.body.data.nextCursor);
      const seen = [...first.body.data.items, ...rest.flat()].map(
        ({ id }: { id: string }) => id,
      );

      expect(seen).toHaveLength(5);
      expect(new Set(seen)).toEqual(new Set(seeded.map(({ id }) => id)));
    });

    it('keeps its place when the job it ended on leaves the filter', async () => {
      const { token, userId } = await register('left-filter');
      const seeded = await jobsFor(
        userId,
        [5, 4, 3, 2, 1].map((hour) => new Date(`2026-11-01T0${hour}:00:00Z`)),
      );

      const first = await get(token, '/jobs?status=QUEUED&limit=2');
      const [, last] = first.body.data.items as { id: string }[];

      // The job the cursor names starts running. A cursor that pointed at the
      // row, rather than carrying its position, would lose its place — and a
      // list that skips the row it points at would drop a real one.
      await prisma.job.update({
        where: { id: last!.id },
        data: { status: 'RUNNING' },
      });

      const second = await get(
        token,
        `/jobs?status=QUEUED&limit=2&cursor=${first.body.data.nextCursor}`,
      );

      expect(
        second.body.data.items.map(({ id }: { id: string }) => id),
      ).toEqual([seeded[2]!.id, seeded[3]!.id]);
    });

    it.each([
      ['an edited cursor', 'cursor=bm90LWEtY3Vyc29y'],
      ['a token that is not base64 JSON', 'cursor=%%%'],
      ["the products list's cursor", 'cursor=eyJza3UiOiJBLTEifQ'],
      ['a limit over 100', 'limit=101'],
      ['an offset, which this list no longer takes', 'offset=20'],
    ])('refuses %s with a 400', async (_label, query) => {
      const { token } = await register('bad-query');

      await get(token, `/jobs?${query}`).expect(400);
    });
  });

  describe('GET /products', () => {
    const catalogOf = (userId: string, count: number) =>
      prisma.product.createMany({
        data: Array.from({ length: count }, (_, index) => ({
          userId,
          sku: `SKU-${String(index).padStart(5, '0')}`,
          name: `Product ${index}`,
          priceCents: 100,
          currency: 'EUR',
        })),
      });

    it('pages a 1 201-product catalog once each, in sku order, and only its own', async () => {
      const [mine, theirs] = [
        await register('catalog'),
        await register('other'),
      ];

      await catalogOf(mine.userId, 1201);
      await catalogOf(theirs.userId, 50);

      const pages = await pagesOf(mine.token, '/products', 100);
      const skus = pages.flat().map(({ sku }) => sku);
      const inOrder = await prisma.product.findMany({
        where: { userId: mine.userId },
        orderBy: { sku: 'asc' },
        select: { sku: true },
      });

      expect(pages).toHaveLength(13);
      expect(pages.at(-1)).toHaveLength(1);
      expect(skus).toEqual(inOrder.map(({ sku }) => sku));
      expect(pages.flat().every(({ id }) => id)).toBe(true);
      expect(
        pages
          .flat()
          .some(
            (product) => 'userId' in product && product.userId !== mine.userId,
          ),
      ).toBe(false);
    });

    it('answers an empty catalog with one empty, final page', async () => {
      const { token } = await register('empty');

      const { body } = await get(token, '/products').expect(200);

      expect(body.data).toEqual({ items: [], nextCursor: null });
    });

    it('refuses a caller with no token', async () => {
      await request(server).get('/products').expect(401);
    });
  });
});
