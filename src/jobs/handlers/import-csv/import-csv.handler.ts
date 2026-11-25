import { Injectable } from '@nestjs/common';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { CsvError } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { z } from 'zod';
import { JobCancelledError, JobHandler } from '../../engine/job-handler.js';
import type { JobContext } from '../../engine/job-context.js';
import { importCsvPayloadSchema, type PayloadOf } from '../../jobs.schema.js';
import { TerminalJobError } from '../../../common/errors/app-error.js';
import { StorageService } from '../../../storage/storage.service.js';
import { errorReportKey, uploadPrefix } from '../../../storage/object-keys.js';
import {
  PRODUCTS_PER_ACCOUNT,
  ProductsService,
  type ProductRow,
} from '../../../products/products.service.js';
import {
  csvRowSchema,
  describeInvalidRow,
  IMPORT_COLUMNS,
} from './import-csv.row.js';
import {
  nameColumns,
  parseFile,
  type ParsedRecord,
} from './import-csv.parse.js';
import { FanOutPlan } from './import-csv.fan-out.js';

// One transaction per batch: short enough to keep each one's row locks brief,
// large enough that a 20 000-row file is 40 round trips rather than 20 000.
const BATCH_SIZE = 500;

// The result carries a few examples, not every bad row: a wrong file can have
// thousands, and the result is a row in Postgres. The full list is the error
// report.
const INVALID_SAMPLES = 10;

// A file whose opening rows are mostly bad is not data with problems but the
// wrong file — an export with decimal commas, a different shop's columns — and
// importing its few valid rows would hide that. Judged on the first rows, so
// it fails in a moment, and on fewer than a batch, so it fails before anything
// is written.
const JUDGED_ROWS = 100;

const REPORT_COLUMNS = ['line', 'reason', ...IMPORT_COLUMNS];

// A valid row the store had no room for (D32): reported like an invalid one,
// since either way the seller's row is not in the catalog.
const OVER_LIMIT = `The store already holds the most products it can (${PRODUCTS_PER_ACCOUNT}); this row's sku would be another`;

// How many of the file's skus a pipeline's import looks up at once: one query
// for each, rather than one per product or one for the whole file.
const LOOKUP_BATCH = 1000;

const count = z.number().int().nonnegative();

// What a committed batch records: how many records it reaches, the totals the
// result reports, and which bytes it was reading — a resume that skipped the
// first 1 000 records of a *different* file would skip rows nobody wrote.
const checkpointSchema = z.object({
  records: count,
  imported: count,
  invalid: count,
  // Of `invalid`, the rows refused for the store's limit: the report looks
  // their skus up only when there are some.
  overLimit: count.default(0),
  invalidSamples: z.array(z.object({ line: count, reason: z.string() })),
  etag: z.string().min(1),
});

type ImportCheckpoint = z.infer<typeof checkpointSchema>;

/** A row of the file on its way to the error report. */
interface Held {
  row: Record<string, unknown>;
  // Invalid, and why; or valid, with the sku to look up.
  reason?: string;
  sku?: string;
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

    const saved = this.readCheckpoint(context);
    const { body: file, etag } = await this.open(key, saved?.etag);

    // Every record up to here is in a batch an earlier attempt committed.
    const resumeAfter = saved?.records ?? 0;

    let rows = 0;
    let imported = saved?.imported ?? 0;
    let invalid = saved?.invalid ?? 0;
    let overLimit = saved?.overLimit ?? 0;
    let invalidSamples = [...(saved?.invalidSamples ?? [])];
    let batch: ProductRow[] = [];
    // Each batched row's line in the file, for a row the store has no room for.
    let lines: number[] = [];

    if (resumeAfter > 0) {
      context.log(`resuming after record ${resumeAfter}`);
      void context.reportProgress({ processed: resumeAfter });
    }

    const write = async () => {
      // What the batch brings the totals to, worked out once for the
      // checkpoint and the import alike.
      const after = ({
        written,
        refused,
      }: {
        written: number;
        refused: string[];
      }) => {
        const over = new Set(refused);
        const refusedLines = batch.flatMap(({ sku }, index) =>
          over.has(sku) ? [lines[index]!] : [],
        );

        return {
          imported: imported + written,
          invalid: invalid + refusedLines.length,
          overLimit: overLimit + refusedLines.length,
          invalidSamples: [
            ...invalidSamples,
            ...refusedLines.map((line) => ({ line, reason: OVER_LIMIT })),
          ].slice(0, INVALID_SAMPLES),
        };
      };

      const totals = after(
        await context.commit(
          (tx) => this.products.upsertWithinLimit(context.userId, batch, tx),
          (outcome): ImportCheckpoint => ({
            records: rows,
            ...after(outcome),
            etag,
          }),
        ),
      );

      ({ imported, invalid, overLimit, invalidSamples } = totals);
      batch = [];
      lines = [];
      void context.reportProgress({ processed: rows });
    };

    const judge = () => {
      if (invalid * 2 > rows) {
        const [example] = invalidSamples;

        throw new TerminalJobError(
          `${invalid} of the first ${rows} rows are invalid (line ${example?.line}: ${example?.reason}); this does not look like a product file in the expected format`,
          'IMPORT_MOSTLY_INVALID',
        );
      }
    };

    try {
      // A pipeline rather than .pipe(): when the loop stops early — a
      // cancellation, a failed write — every stage is destroyed, the S3
      // download included, instead of left open.
      await streamPipeline(
        file,
        parseFile(),
        nameColumns,
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

            if (parsed.success) {
              batch.push(parsed.data);
              lines.push(info.lines);
            } else {
              invalid += 1;

              if (invalidSamples.length < INVALID_SAMPLES) {
                invalidSamples.push({
                  line: info.lines,
                  reason: describeInvalidRow(parsed.error),
                });
              }
            }

            // A resumed import never reaches this row again: whatever
            // committed its checkpoint had already passed it.
            if (rows === JUDGED_ROWS) {
              judge();
            }

            if (batch.length === BATCH_SIZE) {
              await write();

              // Between batches, never inside one: a stopped import has
              // committed whole batches and started none it did not finish.
              if (await context.shouldStop()) {
                throw new JobCancelledError();
              }
            }
          }

          // A file shorter than the judged rows is judged whole, still
          // before its only batch is written.
          if (rows < JUDGED_ROWS) {
            judge();
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

    if (invalid > 0) {
      await this.writeReport(context, key, etag, overLimit > 0);
    }

    const result = { rows, imported, invalid, invalidSamples };

    if (context.pipelineId === null) {
      return result;
    }

    // Before the plan reads the file again: a cancel during the last batch
    // came after the loop's last look. The fan-out refuses one that arrives
    // while the plan is made.
    if (await context.shouldStop()) {
      throw new JobCancelledError();
    }

    // Last, after the report: a pipeline's batches are written once the
    // import has nothing left that could fail it (§6.3e). Not counted in the
    // result: a retry plans from the products as they are by then, and its
    // count says nothing about the batches the pipeline has.
    await context.fanOut(await this.planBatches(context.userId, key, etag));

    return result;
  }

  // Only the bytes the import began with: a resume over different ones would
  // skip rows nobody imported, and a report of them would list the wrong lines.
  private async open(key: string, etag?: string) {
    const opened = await this.storage.openStream(key, { ifMatch: etag });

    if (opened === 'missing') {
      throw new TerminalJobError('The uploaded file no longer exists');
    }

    if (opened === 'changed') {
      throw new TerminalJobError(
        'The file was replaced after this import began; retry with ?from=start to import it from the top',
      );
    }

    return opened;
  }

  // A second read of the file rather than rows collected during the import: a
  // resumed import never checked the rows before its checkpoint, and the report
  // must list those too. It reads, but writes nothing to the database, which is
  // where an import spends its time.
  //
  // A row refused for the store's limit is found as the import left it: valid,
  // with no product. Its sku is looked up only when the import refused some.
  private async writeReport(
    context: JobContext,
    key: string,
    etag: string,
    refusedSome: boolean,
  ) {
    const { body } = await this.open(key, etag);
    const reportable = async (held: Held[]) => {
      const skus = held.flatMap(({ sku }) => (sku === undefined ? [] : [sku]));
      const known =
        skus.length > 0
          ? await this.products.knownSkus(context.userId, skus)
          : new Set<string>();

      return held.flatMap(({ row, sku, reason }) => {
        if (reason !== undefined) {
          return [{ ...row, reason }];
        }

        return known.has(sku!) ? [] : [{ ...row, reason: OVER_LIMIT }];
      });
    };

    const report = stringify({
      header: true,
      columns: REPORT_COLUMNS,
      // Excel reads a CSV without one as its local code page, which garbles
      // any name outside ASCII.
      bom: true,
      // The seller opens this in a spreadsheet, where a cell such as
      // =HYPERLINK(…) from their own file would run as a formula.
      escape_formulas: true,
    });

    const uploading = this.storage
      .upload(errorReportKey(context.userId, context.jobId), report, {
        contentType: 'text/csv; charset=utf-8',
        downloadAs: 'import-errors.csv',
      })
      .catch((error: unknown) => {
        // Nothing else would end the pipeline once S3 stops reading: it would
        // wait for ever for the report to drain.
        report.destroy(error instanceof Error ? error : undefined);

        throw error;
      });

    await Promise.all([
      streamPipeline(
        body,
        parseFile(),
        nameColumns,
        async function* (records: AsyncIterable<ParsedRecord>) {
          // Rows wait here for their skus to be looked up together, so the
          // report keeps the file's order.
          let held: Held[] = [];

          for await (const { record, info } of records) {
            const parsed = csvRowSchema.safeParse(record);
            const row = { ...record, line: info.lines };

            if (!parsed.success) {
              held.push({ row, reason: describeInvalidRow(parsed.error) });
            } else if (refusedSome) {
              held.push({ row, sku: parsed.data.sku });
            }

            if (!refusedSome || held.length === LOOKUP_BATCH) {
              yield* await reportable(held);
              held = [];
            }
          }

          yield* await reportable(held);
        },
        report,
      ),
      uploading,
    ]);
  }

  // The products of the file's valid rows, in file order, each once: what the
  // import wrote, read back from the same bytes rather than gathered while
  // writing, since a resumed import never read the rows before its checkpoint.
  private async planBatches(userId: string, key: string, etag: string) {
    const { body } = await this.open(key, etag);
    const plan = new FanOutPlan();
    const seen = new Set<string>();
    let unread: string[] = [];

    const lookUp = async () => {
      const found = new Map(
        (await this.products.forPipeline(userId, unread)).map((product) => [
          product.sku,
          product,
        ]),
      );

      for (const sku of unread) {
        const product = found.get(sku);

        if (product) {
          plan.add(product);
        }
      }

      unread = [];
    };

    await streamPipeline(
      body,
      parseFile(),
      nameColumns,
      async (records: AsyncIterable<ParsedRecord>) => {
        for await (const { record } of records) {
          const parsed = csvRowSchema.safeParse(record);

          if (parsed.success && !seen.has(parsed.data.sku)) {
            seen.add(parsed.data.sku);
            unread.push(parsed.data.sku);

            if (unread.length === LOOKUP_BATCH) {
              await lookUp();
            }
          }
        }
      },
    );

    if (unread.length > 0) {
      await lookUp();
    }

    return plan.batches();
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
