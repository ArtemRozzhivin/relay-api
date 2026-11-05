import { Injectable } from '@nestjs/common';
import { pipeline } from 'node:stream/promises';
import { CsvError, parse } from 'csv-parse';
import { JobCancelledError, JobHandler } from '../job-handler.js';
import type { JobContext } from '../job-context.js';
import { importCsvPayloadSchema, type PayloadOf } from '../jobs.schema.js';
import { TerminalJobError } from '../../common/errors/app-error.js';
import { StorageService } from '../../storage/storage.service.js';
import { uploadPrefix } from '../../storage/upload-key.js';
import {
  ProductsService,
  type ProductRow,
} from '../../products/products.service.js';
import {
  csvRowSchema,
  describeInvalidRow,
  readHeader,
} from './import-csv.row.js';

// One transaction per batch: short enough to keep each one's row locks brief,
// large enough that a 20 000-row file is 40 round trips rather than 20 000.
const BATCH_SIZE = 500;

// An unclosed quote turns the rest of the file into a single field. Capping a
// record keeps that from pulling the whole file into memory, and fails it as
// malformed instead.
const MAX_RECORD_BYTES = 64 * 1024;

// The result carries a few examples, not every bad row: a wrong file can have
// thousands, and the result is a row in Postgres. The full list is B.5's
// report.
const INVALID_SAMPLES = 10;

interface ParsedRecord {
  record: Record<string, string>;
  info: { lines: number };
}

@Injectable()
export class ImportCsvJobHandler extends JobHandler<PayloadOf<'import.csv'>> {
  readonly type = 'import.csv' as const;

  protected readonly payloadSchema = importCsvPayloadSchema;

  constructor(
    private readonly storage: StorageService,
    private readonly products: ProductsService,
  ) {
    super();
  }

  protected async execute(
    context: JobContext,
    { key }: PayloadOf<'import.csv'>,
  ) {
    // Checked at submit as well. Checked again here because what a worker
    // runs is the stored row, not the request that was checked.
    if (!key.startsWith(uploadPrefix(context.userId))) {
      throw new TerminalJobError('The upload belongs to another account');
    }

    const file = await this.storage.openStream(key);

    if (!file) {
      throw new TerminalJobError('The uploaded file no longer exists');
    }

    let rows = 0;
    let imported = 0;
    let invalid = 0;
    const invalidSamples: { line: number; reason: string }[] = [];
    let batch: ProductRow[] = [];

    const write = async () => {
      imported += await this.products.upsertBatch(context.userId, batch);
      batch = [];
      void context.reportProgress({ processed: rows });
    };

    try {
      // A pipeline rather than .pipe(): when the loop stops early — a
      // cancellation, a failed write — every stage is destroyed, the S3
      // download included, instead of left open.
      await pipeline(
        file,
        parse({
          columns: readHeader,
          info: true,
          bom: true,
          trim: true,
          skip_empty_lines: true,
          // A short or long row is a bad row, reported like any other — not a
          // reason to abandon the whole file.
          relax_column_count: true,
          max_record_size: MAX_RECORD_BYTES,
        }),
        // While this awaits a write it asks for no more records, so the parser
        // stops, the download pauses, and memory holds one batch however long
        // the file is.
        async (records: AsyncIterable<ParsedRecord>) => {
          for await (const { record, info } of records) {
            rows += 1;

            const parsed = csvRowSchema.safeParse(record);

            if (!parsed.success) {
              invalid += 1;

              if (invalidSamples.length < INVALID_SAMPLES) {
                invalidSamples.push({
                  line: info.lines,
                  reason: describeInvalidRow(parsed.error),
                });
              }

              continue;
            }

            batch.push(parsed.data);

            if (batch.length === BATCH_SIZE) {
              await write();

              // Between batches, never inside one: a stopped import has
              // committed whole batches and started none it did not finish.
              if (await context.shouldStop()) {
                throw new JobCancelledError();
              }
            }
          }

          if (batch.length > 0) {
            await write();
          }
        },
      );
    } catch (error) {
      if (error instanceof CsvError) {
        throw new TerminalJobError(
          `The file is not valid CSV near line ${error.lines}: ${error.message}`,
        );
      }

      throw error;
    }

    return { rows, imported, invalid, invalidSamples };
  }
}
