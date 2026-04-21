import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isExpired } from '../src/shared/announcement';

describe('isExpired', () => {
  beforeEach(() => {
    // Pin "today" to 2026-04-20 local time. Use local-time constructor
    // (year, monthIndex, day) not a UTC string, because isExpired uses
    // local-date components.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 3, 20, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when expires is undefined', () => {
    expect(isExpired(undefined)).toBe(false);
  });

  it('returns false when expires is null', () => {
    expect(isExpired(null)).toBe(false);
  });

  it('returns false when expires is empty string', () => {
    expect(isExpired('')).toBe(false);
  });

  it('returns true when expires is strictly before today', () => {
    expect(isExpired('2026-04-19')).toBe(true);
  });

  it('returns false when expires is today (same-day visible)', () => {
    expect(isExpired('2026-04-20')).toBe(false);
  });

  it('returns false when expires is after today', () => {
    expect(isExpired('2026-04-21')).toBe(false);
    expect(isExpired('2099-12-31')).toBe(false);
  });

  it('zero-pads single-digit months and days in today comparison', () => {
    vi.setSystemTime(new Date(2026, 0, 5, 12, 0, 0)); // 2026-01-05
    expect(isExpired('2026-01-04')).toBe(true);
    expect(isExpired('2026-01-05')).toBe(false);
    expect(isExpired('2025-12-31')).toBe(true);
  });
});
