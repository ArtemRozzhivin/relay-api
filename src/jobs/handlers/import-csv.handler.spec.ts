import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { TerminalJobError } from '../../common/errors/app-error.js';
import { mintUploadKey } from '../../storage/object-keys.js';
import type { StorageService } from '../../storage/storage.service.js';
import type { ProductsService } from '../../products/products.service.js';
import { recordingContext } from '../job-context.fixture.js';
import { ImportCsvJobHandler } from './import-csv.handler.js';

describe('the import.csv handler', () => {
  // The memory guard as the job meets it: no S3, a stream that would be
  // megabytes of commas if read to its end.
  it('fails terminally on a row of bare commas, having read only its start', async () => {
    let served = 0;
    const storage = {
      openStream: async () => ({
        etag: '"e1"',
        body: Readable.from(
          (function* () {
            yield Buffer.from('sku,name,price,currency\n');

            for (let i = 0; i < 256; i += 1) {
              served += 32 * 1024;
              yield Buffer.from(','.repeat(32 * 1024));
            }
          })(),
        ),
      }),
    } as unknown as StorageService;
    const handler = new ImportCsvJobHandler(storage, {} as ProductsService);
    const userId = randomUUID();
    const { context } = recordingContext({ userId });

    const failed = handler.run(context, { key: mintUploadKey(userId) });

    await expect(failed).rejects.toBeInstanceOf(TerminalJobError);
    await expect(failed).rejects.toThrow(/near line 2: a row has more than/);
    expect(served).toBeLessThan(256 * 1024);
  });
});
