import { parse } from 'csv-parse';
import { TerminalJobError } from '../../common/errors/app-error.js';
import { readHeader } from './import-csv.row.js';

// An unclosed quote turns the rest of the file into a single field. Capping a
// record's content keeps that from pulling the whole file into memory, and
// fails it as malformed instead.
const MAX_RECORD_BYTES = 64 * 1024;

// The cap above counts field characters, and an empty field has none: a line
// of bare commas — millions of fields — passed it while the record grew
// without bound. A store export has dozens of columns, not a thousand.
const MAX_FIELDS = 1000;

/** One row of an import file, keyed by its columns, and the line it ends on. */
export interface ParsedRecord {
  record: Record<string, string>;
  info: { lines: number };
}

/**
 * The parser every pass over an import file uses, so the error report's line
 * numbers are the ones the import counted. It yields each row as its fields;
 * `nameColumns` keys them.
 *
 * @throws TerminalJobError, through the stream, for a row of more than
 * `MAX_FIELDS` fields, the header included.
 */
export const parseFile = () =>
  parse({
    // The one hook the parser calls as each field ends, so the count stops a
    // record while it is still being read.
    cast: (field, { index, lines }) => {
      if (index >= MAX_FIELDS) {
        throw new TerminalJobError(
          `The file is not valid CSV near line ${lines}: a row has more than ${MAX_FIELDS} fields`,
        );
      }

      return field;
    },
    info: true,
    bom: true,
    trim: true,
    skip_empty_lines: true,
    // A short or long row is a bad row, reported like any other — not a
    // reason to abandon the whole file.
    relax_column_count: true,
    max_record_size: MAX_RECORD_BYTES,
  });

/**
 * Keys each row by the column it sits under, the first row naming them
 * (`readHeader`). Not the parser's own `columns` option: with it, the parser
 * skips the per-field hook for every field past the header's last, which is
 * where a line of bare commas puts its fields.
 *
 * @throws TerminalJobError when the header lacks a required column.
 */
export async function* nameColumns(
  rows: AsyncIterable<{ record: string[]; info: { lines: number } }>,
): AsyncGenerator<ParsedRecord> {
  let columns: (string | undefined)[] | undefined;

  for await (const { record, info } of rows) {
    if (columns === undefined) {
      columns = readHeader(record);
      continue;
    }

    const named: Record<string, string> = {};

    columns.forEach((column, index) => {
      const value = record[index];

      if (column !== undefined && value !== undefined) {
        named[column] = value;
      }
    });

    yield { record: named, info };
  }
}
