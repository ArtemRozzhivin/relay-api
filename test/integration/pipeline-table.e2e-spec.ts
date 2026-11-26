import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../src/prisma/prisma.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  createTestModule,
  createThrowawayUser,
  deleteUsers,
  seedJob,
  seedPipeline,
} from '../support/db.js';

// The rules the table keeps whatever the code does (§4.9): the counter that
// decides when a pipeline is finished never goes below nothing, a final status
// is stamped, and only a pipeline's job holds a place in one.
describe('the Pipeline table', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const users: string[] = [];

  const owner = async () => {
    const userId = await createThrowawayUser(prisma, 'pipeline-table');

    users.push(userId);

    return userId;
  };

  beforeAll(async () => {
    moduleRef = await createTestModule({ imports: [PrismaModule] });
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await deleteUsers(prisma, users);
    await moduleRef?.close();
  });

  it('starts a pipeline running, holding one place for its import', async () => {
    const userId = await owner();
    const pipeline = await seedPipeline(prisma, { userId });
    const job = await seedJob(prisma, {
      userId,
      type: 'import.csv',
      pipelineId: pipeline.id,
      pendingInPipeline: true,
    });

    expect(pipeline).toMatchObject({
      status: 'RUNNING',
      pendingChildren: 1,
      failedChildren: 0,
      finishedAt: null,
    });
    expect(job).toMatchObject({
      pipelineId: pipeline.id,
      pendingInPipeline: true,
    });
  });

  it.each([
    ['pending', `"pendingChildren" = -1`],
    ['failed', `"failedChildren" = -1`],
  ])('refuses a negative %s count', async (_what, assignment) => {
    const pipeline = await seedPipeline(prisma, { userId: await owner() });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Pipeline" SET ${assignment} WHERE "id" = $1::uuid`,
        pipeline.id,
      ),
    ).rejects.toThrow(/Pipeline_counts_not_negative/);
  });

  it.each([
    ['a final status without finishedAt', `"status" = 'COMPLETED'`],
    ['finishedAt while running', `"finishedAt" = now()`],
  ])('refuses %s', async (_what, assignment) => {
    const pipeline = await seedPipeline(prisma, { userId: await owner() });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Pipeline" SET ${assignment} WHERE "id" = $1::uuid`,
        pipeline.id,
      ),
    ).rejects.toThrow(/Pipeline_finished_when_final/);
  });

  it('refuses a FAILED pipeline whose batches were written', async () => {
    const pipeline = await seedPipeline(prisma, {
      userId: await owner(),
      fannedOutAt: new Date(),
    });

    await expect(
      prisma.pipeline.update({
        where: { id: pipeline.id },
        data: { status: 'FAILED', finishedAt: new Date() },
      }),
    ).rejects.toThrow(/Pipeline_failed_only_before_fan_out/);
  });

  it('refuses a job holding a place in no pipeline', async () => {
    await expect(
      seedJob(prisma, { userId: await owner(), pendingInPipeline: true }),
    ).rejects.toThrow(/Job_pending_in_a_pipeline/);
  });

  it("deletes an account's pipelines with it", async () => {
    const userId = await createThrowawayUser(prisma, 'pipeline-table');
    const pipeline = await seedPipeline(prisma, { userId });

    await deleteUsers(prisma, [userId]);

    expect(
      await prisma.pipeline.findUnique({ where: { id: pipeline.id } }),
    ).toBeNull();
  });
});
