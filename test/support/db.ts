import { randomUUID } from 'node:crypto';
import type { ModuleMetadata } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { workerEnvSchema } from '../../src/config/env.schema.js';
import type {
  Prisma,
  PrismaClient,
} from '../../src/generated/prisma/client.js';

/**
 * A Nest testing module, compiled and initialised, with the configuration the
 * worker has. Validated by the worker's own schema, so a test reads the
 * defaults and coerced numbers the process it stands in for would read, and a
 * missing variable fails here rather than as `undefined` halfway through.
 *
 * @param override adjusts the module before it compiles: replaces a provider,
 * say.
 */
export const createTestModule = async (
  { imports = [], ...metadata }: ModuleMetadata,
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (
    builder,
  ) => builder,
) => {
  const moduleRef = await override(
    Test.createTestingModule({
      ...metadata,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          envFilePath: ['.env'],
          validationSchema: workerEnvSchema,
        }),
        ...imports,
      ],
    }),
  ).compile();

  await moduleRef.init();

  return moduleRef;
};

/**
 * A user no other test shares, written straight to the table: for tests that
 * need an owner for their rows, not a login. Delete it with {@link deleteUsers}.
 *
 * @param label names the test in the email, so a leftover row says where it
 * came from.
 * @returns the user's id.
 */
export const createThrowawayUser = async (
  prisma: PrismaClient,
  label: string,
) => {
  const user = await prisma.user.create({
    data: {
      email: `${label}-${randomUUID()}@example.com`,
      passwordHash: 'not-a-real-hash',
    },
  });

  return user.id;
};

/** Deletes test users; their jobs, products and outbox rows go with them. */
export const deleteUsers = (prisma: PrismaClient, ids: string[]) =>
  prisma.user.deleteMany({ where: { id: { in: ids } } });

/**
 * Writes a job row directly, for a test about what happens to a row in some
 * state rather than about how a job gets there. A `QUEUED` `MOCK` job unless
 * `data` says otherwise.
 */
export const seedJob = (
  prisma: PrismaClient,
  data: Partial<Prisma.JobUncheckedCreateInput> & { userId: string },
) =>
  prisma.job.create({
    data: {
      type: 'MOCK',
      payload: {},
      idempotencyKey: `seed-${randomUUID()}`,
      correlationId: 'test',
      // A row built as attempt N of its first life has had N claims.
      lease: data.attempts ?? 0,
      ...data,
    },
  });
