import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { TerminalJobError } from '../../common/errors/app-error.js';
import {
  nameColumns,
  parseFile,
  type ParsedRecord,
} from './import-csv.parse.js';

const HEADER = 'sku,name,price,currency\n';

// The file as chunks, and how many of its bytes the parser asked for: a guard
// that stops a record late has already held it whole.
const read = async (chunks: Iterable<string>) => {
  let served = 0;
  const records: ParsedRecord[] = [];
  const body = Readable.from(
    (function* () {
      for (const chunk of chunks) {
        served += chunk.length;
        yield Buffer.from(chunk);
      }
    })(),
  );

  const finished = pipeline(body, parseFile(), nameColumns, async (rows) => {
    for await (const row of rows as AsyncIterable<ParsedRecord>) {
      records.push(row);
    }
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  return { error: await finished, records, served: () => served };
};

const repeat = function* (times: number, chunk: string) {
  yield HEADER;

  for (let i = 0; i < times; i += 1) {
    yield chunk;
  }
};

describe('reading an import file', () => {
  it('keys each row by its column, skipping unknown ones and absent cells', async () => {
    const { records } = await read([
      'SKU,Name,Price,Currency,Weight\nA-1,Mug,8.99,EUR,3kg\nB-2,Bowl\n',
    ]);

    expect(records).toEqual([
      {
        record: { sku: 'A-1', name: 'Mug', price: '8.99', currency: 'EUR' },
        info: expect.objectContaining({ lines: 2 }),
      },
      {
        record: { sku: 'B-2', name: 'Bowl' },
        info: expect.objectContaining({ lines: 3 }),
      },
    ]);
  });

  // Older spreadsheet exports end lines with \r alone.
  it('reads a file whose lines end in a carriage return', async () => {
    const { records } = await read([
      'sku,name,price,currency\rA-1,"Mug\rlarge",8.99,EUR\rB-2,Bowl,1,EUR\r',
    ]);

    expect(records.map(({ record }) => record.name)).toEqual([
      'Mug\rlarge',
      'Bowl',
    ]);
  });

  it('stops a row of bare commas after its first fields, not at its end', async () => {
    const { error, served } = await read(repeat(64, ','.repeat(32 * 1024)));

    expect(error).toBeInstanceOf(TerminalJobError);
    expect((error as Error).message).toBe(
      'The file is not valid CSV near line 2: a row has more than 1000 fields',
    );
    expect(served()).toBeLessThan(256 * 1024);
  });

  // Each physical line stays short, but the quoted line breaks keep it all
  // one row: a cap per line would let this through.
  it('stops the same row when quoted line breaks split it into short lines', async () => {
    const { error, served } = await read(
      repeat(60, `${','.repeat(60 * 1024)}"\n"`),
    );

    expect((error as Error).message).toMatch(/more than 1000 fields/);
    expect(served()).toBeLessThan(256 * 1024);
  });

  it('refuses a header of more than a thousand columns', async () => {
    const { error } = await read([`${'a,'.repeat(1500)}b\n1,2\n`]);

    expect((error as Error).message).toMatch(/line 1: a row has more than/);
  });
});
