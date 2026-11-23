import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { JobTransitionService } from '../../src/jobs/job-transition.service.js';
import {
  createTestModule,
  createThrowawayUser,
  deleteUsers,
  seedJob,
} from '../support/db.js';

// What a job's requests to a model used, as the row keeps it: a total that
// only grows, from whichever attempt made the request (§6.3d).
describe("a job's model usage", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let transitions: JobTransitionService;
  const users: string[] = [];

  const jobFor = async (
    data: Omit<Parameters<typeof seedJob>[1], 'userId'> = {},
  ) => {
    const userId = await createThrowawayUser(prisma, 'usage');

    users.push(userId);

    return seedJob(prisma, { userId, ...data });
  };

  const usageOf = async (jobId: string) => {
    const { tokensIn, tokensOut, estimatedCostUsd } =
      await prisma.job.findUniqueOrThrow({ where: { id: jobId } });

    return {
      tokensIn,
      tokensOut,
      estimatedCostUsd: estimatedCostUsd.toNumber(),
    };
  };

  beforeAll(async () => {
    moduleRef = await createTestModule({
      imports: [PrismaModule],
      providers: [JobTransitionService],
    });
    prisma = moduleRef.get(PrismaService);
    transitions = moduleRef.get(JobTransitionService);
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await moduleRef?.close();
  });

  it('adds each reply to the totals', async () => {
    const job = await jobFor({ status: 'RUNNING', attempts: 1 });

    await transitions.addModelUsage(job.id, {
      tokensIn: 120,
      tokensOut: 40,
      estimatedCostUsd: 0.00032,
    });
    await transitions.addModelUsage(job.id, {
      tokensIn: 30,
      tokensOut: 10,
      estimatedCostUsd: 0.00008,
    });

    expect(await usageOf(job.id)).toEqual({
      tokensIn: 150,
      tokensOut: 50,
      estimatedCostUsd: 0.0004,
    });
  });

  // An attempt that lost the job, to a redelivery or a re-drive, still spent
  // what it spent; a guard here would make the total read low.
  it('adds what an attempt spent after it lost the job', async () => {
    const job = await jobFor({ status: 'DEAD_LETTERED', attempts: 3 });

    await transitions.addModelUsage(job.id, {
      tokensIn: 100,
      tokensOut: 20,
      estimatedCostUsd: 0.0002,
    });

    expect(await usageOf(job.id)).toEqual({
      tokensIn: 100,
      tokensOut: 20,
      estimatedCostUsd: 0.0002,
    });
  });

  it('keeps the cost to the millionth of a dollar', async () => {
    const job = await jobFor();

    await transitions.addModelUsage(job.id, {
      tokensIn: 1,
      tokensOut: 1,
      estimatedCostUsd: 0.0000064,
    });

    expect((await usageOf(job.id)).estimatedCostUsd).toBe(0.000006);
  });

  // The floor under the code that adds: no total goes below nothing.
  it.each([
    ['tokens in', `"tokensIn" = -1`],
    ['tokens out', `"tokensOut" = -1`],
    ['a cost', `"estimatedCostUsd" = -0.000001`],
  ])('refuses a negative total of %s', async (_what, assignment) => {
    const job = await jobFor();

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Job" SET ${assignment} WHERE "id" = $1::uuid`,
        job.id,
      ),
    ).rejects.toThrow(/Job_model_usage_not_negative/);
  });
});
