import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { JobTransitionService } from '../../src/jobs/job-transition.service.js';
import {
  createTestModule,
  createThrowawayUser,
  deleteUsers,
  seedJob,
} from '../support/db.js';

// A checkpoint is only worth resuming from if it describes exactly the work
// that committed: never more, or a resume skips rows nobody wrote; never less
// from an attempt that lost the job, or two workers write one batch twice.
describe('the checkpoint transaction', () => {
  let prisma: PrismaService;
  let transitions: JobTransitionService;
  let userId: string;

  const claimedJob = async () => {
    const job = await seedJob(prisma, { userId, type: 'import.csv' });
    const claimed = await transitions.claim(job.id);

    return { jobId: job.id, lease: claimed!.lease };
  };

  // The batch: one product, so whether it committed is one row to look for.
  const writeProduct =
    (sku: string) =>
    async (tx: Prisma.TransactionClient): Promise<number> => {
      await tx.product.create({
        data: { userId, sku, name: sku, priceCents: 100, currency: 'EUR' },
      });

      return 1;
    };

  const product = (sku: string) =>
    prisma.product.findUnique({ where: { userId_sku: { userId, sku } } });

  const checkpointOf = async (jobId: string) =>
    (await prisma.job.findUniqueOrThrow({ where: { id: jobId } })).checkpoint;

  beforeAll(async () => {
    const moduleRef = await createTestModule({
      imports: [PrismaModule],
      providers: [JobTransitionService],
    });

    prisma = moduleRef.get(PrismaService);
    transitions = moduleRef.get(JobTransitionService);

    userId = await createThrowawayUser(prisma, 'checkpoint');
  });

  afterAll(async () => {
    await deleteUsers(prisma, [userId]);
    await prisma.$disconnect();
  });

  it('commits the work and its checkpoint together', async () => {
    const { jobId, lease } = await claimedJob();

    const committed = await transitions.commitCheckpoint(
      jobId,
      lease,
      writeProduct('A-1'),
      (written) => ({ records: written }),
    );

    expect(committed).toEqual({ value: 1 });
    expect(await product('A-1')).not.toBeNull();
    expect(await checkpointOf(jobId)).toEqual({ records: 1 });
  });

  it('rolls the work back for an attempt that no longer owns the job', async () => {
    const { jobId, lease } = await claimedJob();

    await transitions.commitCheckpoint(
      jobId,
      lease,
      writeProduct('B-1'),
      () => ({
        records: 1,
      }),
    );

    // The queue gave up on this delivery and handed the job to another.
    await transitions.claim(jobId);

    const refused = await transitions.commitCheckpoint(
      jobId,
      lease,
      writeProduct('B-2'),
      () => ({ records: 2 }),
    );

    expect(refused).toBeNull();
    expect(await product('B-2')).toBeNull();
    expect(await checkpointOf(jobId)).toEqual({ records: 1 });
  });

  it('records no checkpoint for work that failed', async () => {
    const { jobId, lease } = await claimedJob();

    await expect(
      transitions.commitCheckpoint(
        jobId,
        lease,
        async (tx) => {
          await writeProduct('C-1')(tx);
          throw new Error('connection terminated');
        },
        () => ({ records: 1 }),
      ),
    ).rejects.toThrow('connection terminated');

    expect(await product('C-1')).toBeNull();
    expect(await checkpointOf(jobId)).toBeNull();
  });

  describe('a re-drive', () => {
    const deadLetterWithCheckpoint = async () => {
      const { jobId, lease } = await claimedJob();

      await transitions.commitCheckpoint(
        jobId,
        lease,
        async () => 0,
        () => ({ records: 1000 }),
      );
      await transitions.deadLetter(jobId, lease, {
        code: 'TERMINAL_FAILURE',
        message: 'test',
      });

      return jobId;
    };

    it('keeps the checkpoint, so the job resumes', async () => {
      const jobId = await deadLetterWithCheckpoint();

      const redriven = await transitions.redrive(jobId);

      expect(redriven?.checkpoint).toEqual({ records: 1000 });
      // Cleared all the same: the resumed run reports its own.
      expect(redriven?.progress).toBeNull();
    });

    it('clears it when asked to start over', async () => {
      const jobId = await deadLetterWithCheckpoint();

      const redriven = await transitions.redrive(jobId, undefined, {
        fromStart: true,
      });

      expect(redriven?.checkpoint).toBeNull();
    });
  });
});
