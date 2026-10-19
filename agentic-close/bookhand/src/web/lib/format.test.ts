import { describe, expect, it } from 'vitest';
import { money } from './format';

describe('money formatting', () => {
  it('B-1: never shows a negative zero ("-$0")', () => {
    expect(money(-40, 'USD', { cents: false })).toBe('$0');
    expect(money(-49, 'USD', { cents: false })).toBe('$0');
    expect(money(-0)).toBe('$0.00');
    expect(money(-4, 'USD', { compact: true })).toBe('$0');
    expect(money(-40, 'USD', { cents: false, signed: true })).toBe('$0');
    // Amounts that do not round to zero keep their sign.
    expect(money(-50, 'USD', { cents: false })).toBe('-$1');
    expect(money(-1)).toBe('-$0.01');
  });
});
