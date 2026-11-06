import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { StorageModule } from '../../src/storage/storage.module.js';
import { StorageService } from '../../src/storage/storage.service.js';
import { mintUploadKey } from '../../src/storage/upload-key.js';
import { ProductsModule } from '../../src/products/products.module.js';
import { ImportCsvJobHandler } from '../../src/jobs/handlers/import-csv.handler.js';
import { JobCancelledError } from '../../src/jobs/job-handler.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { recordingContext } from '../../src/jobs/job-context.fixture.js';
import { TerminalJobError } from '../../src/common/errors/app-error.js';
import { workerEnvSchema } from '../../src/config/env.schema.js';
import { postUploadForm } from '../support/upload-form.js';

// The handler against what it really reads and writes: a file in the dev
// bucket (D29) and the Product table. Each file is uploaded the way a client
// would, under a key minted for its test user.
describe('the import.csv handler', () => {
  let prisma: PrismaService;
  let storage: StorageService;
  let handler: ImportCsvJobHandler;
  const users: string[] = [];

  const store = async () => {
    const user = await prisma.user.create({
      data: {
        email: `import-${randomUUID()}@example.com`,
        passwordHash: 'not-a-real-hash',
      },
    });

    users.push(user.id);

    return user.id;
  };

  const upload = async (
    userId: string,
    csv: string,
    key = mintUploadKey(userId),
  ) => {
    const slip = await storage.signUpload(key, 5 * 1024 * 1024, 60);
    const response = await postUploadForm(slip, csv);

    expect(response.status).toBe(204);

    return key;
  };

  const run = (
    userId: string,
    key: string,
    options: { stopAfterChecks?: number; checkpoint?: Prisma.JsonValue } = {},
  ) => {
    const recorded = recordingContext({ userId, client: prisma, ...options });

    return {
      ...recorded,
      result: handler.run(recorded.context, { key }),
    };
  };

  const catalog = (userId: string) =>
    prisma.product.findMany({ where: { userId }, orderBy: { sku: 'asc' } });

  const rowsOf = (count: number) =>
    [
      'sku,name,price,currency',
      ...Array.from(
        { length: count },
        (_, index) => `SKU-${index},Product ${index},1.00,EUR`,
      ),
    ].join('\n');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          envFilePath: ['.env'],
          validationSchema: workerEnvSchema,
        }),
        PrismaModule,
        StorageModule,
        ProductsModule,
      ],
      providers: [ImportCsvJobHandler],
    }).compile();

    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    storage = moduleRef.get(StorageService);
    handler = moduleRef.get(ImportCsvJobHandler);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });

  it('writes the valid rows and counts the bad ones by their line in the file', async () => {
    const userId = await store();
    const key = await upload(
      userId,
      [
        'sku,name,price,currency,description,imageUrl,weight',
        'A-1,Mug,8.99,eur,A mug,https://example.com/a.jpg,300',
        'B-2,,5,EUR,,,',
        'C-3,Plate,abc,EUR',
        'D-4,Bowl,12.5,usd',
      ].join('\n'),
    );

    expect(await run(userId, key).result).toEqual({
      rows: 4,
      imported: 2,
      invalid: 2,
      invalidSamples: [
        { line: 3, reason: expect.stringMatching(/^name:/) },
        { line: 4, reason: expect.stringMatching(/^price:/) },
      ],
    });

    expect(await catalog(userId)).toMatchObject([
      {
        sku: 'A-1',
        name: 'Mug',
        description: 'A mug',
        priceCents: 899,
        currency: 'EUR',
        imageUrl: 'https://example.com/a.jpg',
      },
      { sku: 'D-4', priceCents: 1250, currency: 'USD', description: null },
    ]);
  });

  it('writes in batches of 500 and reports progress after each one', async () => {
    const userId = await store();
    const key = await upload(userId, rowsOf(1201));

    const { result, reports, checks } = run(userId, key);

    expect(await result).toMatchObject({ rows: 1201, imported: 1201 });
    expect(reports.map((report) => report.processed)).toEqual([
      500, 1000, 1201,
    ]);
    // Asked after each full batch, not after the last partial one: by then
    // the import is finished, and stopping would only discard the answer.
    expect(checks()).toBe(2);
    expect(await catalog(userId)).toHaveLength(1201);
  });

  it('stops at a batch boundary when asked, keeping the batches already written', async () => {
    const userId = await store();
    const key = await upload(userId, rowsOf(1201));

    await expect(
      run(userId, key, { stopAfterChecks: 1 }).result,
    ).rejects.toBeInstanceOf(JobCancelledError);

    expect(await catalog(userId)).toHaveLength(1000);
  });

  // What A14 and A15 rest on: running the same file again leaves the catalog
  // exactly as one run did.
  it('leaves the catalog unchanged when the same file is imported again', async () => {
    const userId = await store();
    const key = await upload(userId, rowsOf(30));

    // updatedAt moves, and only it: the rows are rewritten with the same
    // values, in place, under the same ids.
    const withoutUpdatedAt = async () =>
      (await catalog(userId)).map(
        ({ updatedAt: _updatedAt, ...product }) => product,
      );

    await run(userId, key).result;
    const first = await withoutUpdatedAt();

    await run(userId, key).result;

    expect(await withoutUpdatedAt()).toEqual(first);
  });

  it('reads a header in any case, after a byte-order mark', async () => {
    const userId = await store();
    const key = await upload(userId, '﻿SKU,NAME,PRICE,CURRENCY\nA-1,Mug,1,EUR');

    expect(await run(userId, key).result).toMatchObject({ imported: 1 });
  });

  it.each([
    ['without a required column', 'sku,name,currency\nA-1,Mug,EUR', /price/],
    [
      'that is not valid CSV',
      'sku,name,price,currency\n"A-1,Mug,1,EUR',
      /not valid CSV/,
    ],
  ])(
    'fails for good on a file %s, writing nothing',
    async (_label, csv, reason) => {
      const userId = await store();
      const key = await upload(userId, csv);

      const failure = run(userId, key).result;

      await expect(failure).rejects.toBeInstanceOf(TerminalJobError);
      await expect(failure).rejects.toThrow(reason);
      expect(await catalog(userId)).toEqual([]);
    },
  );

  it("refuses a key under another account's prefix", async () => {
    const userId = await store();
    const theirs = mintUploadKey(randomUUID());

    await expect(run(userId, theirs).result).rejects.toThrow(/another account/);
  });

  it('fails for good when the file is no longer there', async () => {
    const userId = await store();

    await expect(run(userId, mintUploadKey(userId)).result).rejects.toThrow(
      /no longer exists/,
    );
  });

  describe('resuming from a checkpoint', () => {
    // One bad row ahead of the first batch, so the counts a resume carries
    // forward are not all equal to the row count.
    const csv = [
      'sku,name,price,currency',
      'BAD,Broken,abc,EUR',
      ...Array.from(
        { length: 1200 },
        (_, index) => `SKU-${index},Product ${index},1.00,EUR`,
      ),
    ].join('\n');

    // Stopped after its second batch: 1 000 products written, and the
    // checkpoint those two batches committed.
    const interrupted = async () => {
      const userId = await store();
      const key = await upload(userId, csv);
      const first = run(userId, key, { stopAfterChecks: 1 });

      await expect(first.result).rejects.toBeInstanceOf(JobCancelledError);

      return {
        userId,
        key,
        checkpoint: first.checkpoints.at(-1) as Prisma.JsonValue,
      };
    };

    it('records how far each committed batch reaches', async () => {
      const userId = await store();
      const key = await upload(userId, csv);
      const { result, checkpoints } = run(userId, key);

      await result;

      expect(checkpoints).toEqual([
        expect.objectContaining({ records: 501, imported: 500, invalid: 1 }),
        expect.objectContaining({ records: 1001, imported: 1000, invalid: 1 }),
        expect.objectContaining({ records: 1201, imported: 1200, invalid: 1 }),
      ]);
      expect(checkpoints[0]).toMatchObject({
        etag: expect.stringMatching(/^".+"$/),
        invalidSamples: [{ line: 2, reason: expect.stringMatching(/^price:/) }],
      });
    });

    it('skips what the checkpoint covers and still reports the whole file', async () => {
      const { userId, key, checkpoint } = await interrupted();
      const before = await catalog(userId);

      expect(before).toHaveLength(1000);

      const second = run(userId, key, { checkpoint });

      expect(await second.result).toEqual({
        rows: 1201,
        imported: 1200,
        invalid: 1,
        invalidSamples: [{ line: 2, reason: expect.stringMatching(/^price:/) }],
      });

      // The proof it resumed rather than restarted: the 1 000 products the
      // first run wrote were not written again.
      const after = await catalog(userId);
      const rewritten = before.filter(
        (product) =>
          after.find(({ sku }) => sku === product.sku)?.updatedAt.getTime() !==
          product.updatedAt.getTime(),
      );

      expect(after).toHaveLength(1200);
      expect(rewritten).toEqual([]);
      expect(second.reports.map((report) => report.processed)).toEqual([
        1001, 1201,
      ]);
      expect(second.lines).toContain('resuming after record 1001');
    });

    it('fails for good when the file was replaced after the import began', async () => {
      const { userId, key, checkpoint } = await interrupted();

      // The upload slip is reusable until it expires, so the same key can be
      // given different bytes; resuming would skip 1 001 records of a file
      // nobody imported.
      await upload(userId, rowsOf(1500), key);

      await expect(run(userId, key, { checkpoint }).result).rejects.toThrow(
        /replaced after this import began/,
      );
      expect(await catalog(userId)).toHaveLength(1000);
    });

    it('imports from the top when the checkpoint cannot be read', async () => {
      const { userId, key } = await interrupted();

      const again = run(userId, key, { checkpoint: { phase: 'extract' } });

      expect(await again.result).toMatchObject({ rows: 1201, imported: 1200 });
      expect(again.lines).toContain(
        'checkpoint unreadable; importing from the top',
      );
    });
  });
});
