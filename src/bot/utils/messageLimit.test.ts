import { describe, expect, test } from 'bun:test';
import { clipText, DISCORD_MESSAGE_LIMIT, joinWithinLimit } from './messageLimit';

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

describe('clipText', () => {
  test('keeps text within the limit unchanged', () => {
    expect(clipText('abc', 3)).toBe('abc');
  });

  test('cuts longer text to the limit, ending in an ellipsis', () => {
    expect(clipText('abcdef', 4)).toBe('abc…');
  });

  test('never splits a surrogate pair at the cut', () => {
    // '🔥' is two UTF-16 units; a cut after 'ab' plus its high half would leave a lone surrogate.
    const clipped = clipText('ab🔥cdef', 4);
    expect(clipped).toBe('ab…');
    expect(clipped.isWellFormed()).toBe(true);
  });

  test('keeps a whole surrogate pair that fits before the cut', () => {
    expect(clipText('a🔥bcdef', 4)).toBe('a🔥…');
  });

  test('defaults to the Discord message limit', () => {
    const clipped = clipText('x'.repeat(5000));
    expect(clipped).toHaveLength(DISCORD_MESSAGE_LIMIT);
    expect(clipped.endsWith('…')).toBe(true);
  });
});
