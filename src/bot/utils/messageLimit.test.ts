import { describe, expect, test } from 'bun:test';
import { joinWithinLimit } from './messageLimit';

describe('joinWithinLimit', () => {
  test('joins short lists unchanged', () => {
    expect(joinWithinLimit('A: ', ['1', '2'])).toBe('A: 1, 2');
  });

  test('truncates with a count when over the limit', () => {
    const items = Array.from({ length: 1000 }, (_, i) => String(i));
    const text = joinWithinLimit('A: ', items);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toMatch(/… and \d+ more$/);
  });

  test('honours a custom limit', () => {
    const text = joinWithinLimit('A: ', ['11', '22', '33', '44'], 15);
    expect(text.length).toBeLessThanOrEqual(15);
    expect(text).toContain('more');
  });
});
