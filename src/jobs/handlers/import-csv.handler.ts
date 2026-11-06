import { Injectable } from '@nestjs/common';
import { pipeline } from 'node:stream/promises';
import { CsvError, parse } from 'csv-parse';
import { z } from 'zod';
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

const count = z.number().int().nonnegative();

// What a committed batch records: how many records it reaches, the totals the
// result reports, and which bytes it was reading — a resume that skipped the
// first 1 000 records of a *different* file would skip rows nobody wrote.
const checkpointSchema = z.object({
  records: count,
  imported: count,
  invalid: count,
  invalidSamples: z.array(z.object({ line: count, reason: z.string() })),
  etag: z.string().min(1),
});

type ImportCheckpoint = z.infer<typeof checkpointSchema>;

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

    const saved = this.readCheckpoint(context);
    const opened = await this.storage.openStream(key, {
      ifMatch: saved?.etag,
    });

    if (opened === 'missing') {
      throw new TerminalJobError('The uploaded file no longer exists');
    }

    if (opened === 'changed') {
      throw new TerminalJobError(
        'The file was replaced after this import began; retry with ?from=start to import it from the top',
      );
    }

    const { body: file, etag } = opened;

    // Every record up to here is in a batch an earlier attempt committed.
    const resumeAfter = saved?.records ?? 0;

    let rows = 0;
    let imported = saved?.imported ?? 0;
    let invalid = saved?.invalid ?? 0;
    const invalidSamples = [...(saved?.invalidSamples ?? [])];
    let batch: ProductRow[] = [];

    if (resumeAfter > 0) {
      context.log(`resuming after record ${resumeAfter}`);
      void context.reportProgress({ processed: resumeAfter });
    }

    const write = async () => {
      const written = await context.commit(
        (tx) => this.products.upsertBatch(context.userId, batch, tx),
        (upserted): ImportCheckpoint => ({
          records: rows,
          imported: imported + upserted,
          invalid,
          // A copy: the array keeps growing after this batch commits.
          invalidSamples: [...invalidSamples],
          etag,
        }),
      );

      imported += written;
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

            // Still parsed, because only parsing finds where a CSV record ends
            // — a quoted field may hold a newline — but neither checked nor
            // written again.
            if (rows <= resumeAfter) {
              continue;
            }

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

  // A checkpoint this version cannot read costs a restart from the top, which
  // the upsert makes harmless. Trusting one would skip rows for no reason
  // anyone could later see.
  private readCheckpoint(context: JobContext) {
    if (context.checkpoint === null) {
      return undefined;
    }

    const parsed = checkpointSchema.safeParse(context.checkpoint);

    if (!parsed.success) {
      context.log('checkpoint unreadable; importing from the top');

      return undefined;
    }

    return parsed.data;
  }
}
