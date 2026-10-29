import { describe, expect, it } from 'vitest';
import { fmtMinutes, initials } from './format';

describe('formatters', () => {
  it('formats durations', () => {
    expect(fmtMinutes(45)).toBe('45m');
    expect(fmtMinutes(120)).toBe('2h');
    expect(fmtMinutes(135)).toBe('2h 15m');
  });
  it('derives initials', () => {
    expect(initials('Dana Whitfield')).toBe('DW');
    expect(initials('dana@x.com')).toBe('D');
    expect(initials(null)).toBe('?');
  });
});
