import { describe, it, expect } from 'vitest';
import { addedLabel, longDate, runtime, seasons, relativeTime } from './format';

describe('format', () => {
  const now = new Date('2026-11-23T15:00:00');
  it('labels date added, adding the year only when it differs', () => {
    expect(addedLabel(new Date('2026-11-22T11:23:00').toISOString(), now)).toBe('Added Nov 22');
    expect(addedLabel(new Date('2025-03-02T11:23:00').toISOString(), now)).toBe('Added Mar 2, 2025');
    expect(addedLabel(null, now)).toBeNull();
  });
  it('does not shift plain release dates across days', () => {
    expect(longDate('2026-03-08')).toBe('Mar 8, 2026');
  });
  it('formats runtime and seasons', () => {
    expect(runtime(112)).toBe('1h 52m');
    expect(runtime(45)).toBe('45m');
    expect(runtime(null)).toBeNull();
    expect(seasons(1)).toBe('1 season');
    expect(seasons(3)).toBe('3 seasons');
  });
  it('relative sync time', () => {
    expect(relativeTime(new Date('2026-11-23T06:23:00').toISOString(), now)).toBe('today, 6:23 AM');
    expect(relativeTime(new Date('2026-11-22T06:23:00').toISOString(), now)).toBe('yesterday, 6:23 AM');
  });
});
