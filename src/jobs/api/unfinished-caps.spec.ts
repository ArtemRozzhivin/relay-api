import { describe, expect, it } from 'vitest';
import { withinRoom } from './unfinished-caps.js';

const jobs = (...types: string[]) =>
  types.map((type, index) => ({ id: `job-${index}`, type }));

describe('withinRoom', () => {
  it('keeps a capped type only as far as its room goes, in order', () => {
    const room = new Map([['import.csv', 2]]);

    expect(
      withinRoom(
        jobs('import.csv', 'import.csv', 'import.csv', 'import.csv'),
        room,
      ).map(({ id }) => id),
    ).toEqual(['job-0', 'job-1']);
  });

  it('keeps every job of a type without a cap', () => {
    const room = new Map([['import.csv', 0]]);

    expect(
      withinRoom(jobs('MOCK', 'import.csv', 'CHARGE'), room).map(
        ({ type }) => type,
      ),
    ).toEqual(['MOCK', 'CHARGE']);
  });

  it('counts each type against its own room', () => {
    const room = new Map([
      ['import.csv', 1],
      ['image.process', 2],
    ]);

    expect(
      withinRoom(
        jobs(
          'import.csv',
          'image.process',
          'import.csv',
          'image.process',
          'image.process',
        ),
        room,
      ).map(({ id }) => id),
    ).toEqual(['job-0', 'job-1', 'job-3']);
  });

  it('keeps nothing of a type already past its cap', () => {
    expect(
      withinRoom(jobs('import.csv'), new Map([['import.csv', -1]])),
    ).toEqual([]);
  });

  it('leaves the room it was given as it was', () => {
    const room = new Map([['import.csv', 1]]);

    withinRoom(jobs('import.csv', 'import.csv'), room);

    expect(room.get('import.csv')).toBe(1);
  });
});
