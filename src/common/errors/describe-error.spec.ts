import { describe, expect, it } from 'vitest';
import { describeError } from './describe-error.js';

describe('describeError', () => {
  // Not String(error), which would prefix every line with the class name.
  it("reads an Error's message alone", () => {
    expect(describeError(new TypeError('socket hang up'))).toBe(
      'socket hang up',
    );
  });

  it('reads anything else that was thrown as text', () => {
    expect(describeError('timed out')).toBe('timed out');
    expect(describeError(undefined)).toBe('undefined');
  });

  // As Node reports a host none of whose addresses answered: no message.
  it('reads an AggregateError with no message by what it holds, each once', () => {
    const refused = (address: string) =>
      new Error(`connect ECONNREFUSED ${address}:443`);

    expect(
      describeError(
        new AggregateError([
          refused('203.0.113.1'),
          refused('2001:db8::1'),
          refused('203.0.113.1'),
        ]),
      ),
    ).toBe(
      'connect ECONNREFUSED 203.0.113.1:443; connect ECONNREFUSED 2001:db8::1:443',
    );
  });

  it("reads an AggregateError's own message when it has one", () => {
    expect(
      describeError(new AggregateError([new Error('inner')], 'outer')),
    ).toBe('outer');
  });
});
