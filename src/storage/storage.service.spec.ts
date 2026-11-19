import type { ConfigService } from '@nestjs/config';
import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SharedEnv } from '../config/env.schema.js';
import { StorageService } from './storage.service.js';

const config = {
  get: (name: string) =>
    ({ AWS_REGION: 'eu-central-1', S3_BUCKET: 'a-bucket' })[name],
} as unknown as ConfigService<SharedEnv, true>;

describe('StorageService.deleteObjects', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends at most a thousand keys a request', async () => {
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({} as never);
    const keys = Array.from({ length: 2500 }, (_, n) => `k${n}`);

    await new StorageService(config).deleteObjects(keys);

    expect(
      send.mock.calls.map(
        ([command]) =>
          (command as DeleteObjectsCommand).input.Delete!.Objects!.length,
      ),
    ).toEqual([1000, 1000, 500]);
  });

  // S3 answers 200 and lists what it refused; read as success, a sweep would
  // count folders as deleted that are still there.
  it('throws when S3 refuses a key in a request it answered 200', async () => {
    vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({
      Errors: [{ Key: 'k1', Code: 'AccessDenied' }],
    } as never);

    await expect(
      new StorageService(config).deleteObjects(['k1', 'k2']),
    ).rejects.toThrow('S3 refused to delete 1 object(s), the first k1');
  });
});
