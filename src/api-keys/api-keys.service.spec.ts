import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeysService } from './api-keys.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ApiEnv } from '../config/env.schema.js';

const MINUTE = 60_000;

// What a request's key reads as, last used `ago` ms before now (null: never).
const keyUsed = (ago: number | null) => ({
  id: 'a-key',
  scopes: ['read'],
  revokedAt: null,
  lastUsedAt: ago === null ? null : new Date(Date.now() - ago),
  user: { id: 'a-user', email: 'a@example.com', role: 'USER' },
});

const serviceFor = (
  found: ReturnType<typeof keyUsed>,
  updateMany = vi.fn(async () => ({ count: 1 })),
) => {
  const prisma = {
    apiKey: { findUnique: vi.fn(async () => found), updateMany },
  } as unknown as PrismaService;
  const config = {
    get: () => true,
  } as unknown as ConfigService<ApiEnv, true>;

  return { service: new ApiKeysService(prisma, config), updateMany };
};

// When a key's use is written down: once a minute at most, and never at the
// cost of the request it came with (§6.3f).
describe('ApiKeysService.authenticate', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the use of a key never used', async () => {
    const { service, updateMany } = serviceFor(keyUsed(null));

    await service.authenticate('relay_x');

    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('writes the use of a key last used over a minute ago, if no one has since', async () => {
    const { service, updateMany } = serviceFor(keyUsed(2 * MINUTE));

    await service.authenticate('relay_x');

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'a-key',
          OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: expect.any(Date) } }],
        }),
      }),
    );
  });

  it('asks the database nothing more for a key used within the minute', async () => {
    const { service, updateMany } = serviceFor(keyUsed(10_000));

    await service.authenticate('relay_x');

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('lets the request in when the write fails, and says so', async () => {
    const { service } = serviceFor(
      keyUsed(null),
      vi.fn(async () => {
        throw new Error('the database went away');
      }),
    );

    await expect(service.authenticate('relay_x')).resolves.toMatchObject({
      id: 'a-key',
    });
    await vi.waitFor(() =>
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining('the database went away'),
      ),
    );
  });
});
