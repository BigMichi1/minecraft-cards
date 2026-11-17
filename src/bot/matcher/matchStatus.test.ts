import { describe, expect, test } from 'bun:test';
import { MATCH_STATUSES } from './matchStatus';

describe('MATCH_STATUSES', () => {
  test('lists every status once', () => {
    expect(new Set(MATCH_STATUSES).size).toBe(MATCH_STATUSES.length);
    expect(MATCH_STATUSES).toContain('pending');
    expect(MATCH_STATUSES).toContain('image_unavailable');
  });
});
