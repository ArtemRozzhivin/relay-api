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
});
