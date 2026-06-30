import { describe, it, expect } from 'vitest';
import { isValidIanaTimezone, isWithinBusinessHours } from './business-hours.js';

describe('isValidIanaTimezone', () => {
  it('accepts valid IANA zones', () => {
    expect(isValidIanaTimezone('America/New_York')).toBe(true);
    expect(isValidIanaTimezone('UTC')).toBe(true);
    expect(isValidIanaTimezone('Europe/London')).toBe(true);
  });
  it('rejects invalid / empty', () => {
    expect(isValidIanaTimezone('Not/AZone')).toBe(false);
    expect(isValidIanaTimezone('')).toBe(false);
    expect(isValidIanaTimezone(undefined)).toBe(false);
    expect(isValidIanaTimezone(null)).toBe(false);
  });
});

describe('isWithinBusinessHours', () => {
  const hours = { start: 9, end: 17, timezone: 'America/New_York' };

  it('true at 14:00 ET (18:00Z) — inside', () => {
    expect(isWithinBusinessHours('2025-06-30T18:00:00.000Z', hours)).toBe(true);
  });
  it('false at 23:00 ET (03:00Z next day) — outside', () => {
    expect(isWithinBusinessHours('2025-06-30T03:00:00.000Z', hours)).toBe(false);
  });
  it('false exactly at end hour (17:00 ET = 21:00Z) — window is [start,end)', () => {
    expect(isWithinBusinessHours('2025-06-30T21:00:00.000Z', hours)).toBe(false);
  });
  it('true exactly at start hour (09:00 ET = 13:00Z)', () => {
    expect(isWithinBusinessHours('2025-06-30T13:00:00.000Z', hours)).toBe(true);
  });
  it('invalid timezone → false', () => {
    expect(isWithinBusinessHours('2025-06-30T18:00:00.000Z', { ...hours, timezone: 'X/Y' })).toBe(false);
  });
  it('invalid datetime → false', () => {
    expect(isWithinBusinessHours('not-a-date', hours)).toBe(false);
  });
  it('malformed window (start >= end) → false', () => {
    expect(isWithinBusinessHours('2025-06-30T18:00:00.000Z', { ...hours, start: 17, end: 9 })).toBe(false);
  });
});
