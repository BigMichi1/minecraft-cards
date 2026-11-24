import { describe, expect, test } from 'bun:test';
import { isAdminConfirmed, isConfirmable, MATCH_STATUSES } from './matchStatus';

describe('MATCH_STATUSES', () => {
  test('lists every status once', () => {
    expect(new Set(MATCH_STATUSES).size).toBe(MATCH_STATUSES.length);
    expect(MATCH_STATUSES).toContain('pending');
    expect(MATCH_STATUSES).toContain('image_unavailable');
    expect(MATCH_STATUSES).toContain('mismatch');
  });
});

describe('admin confirmation rules', () => {
  test('isAdminConfirmed: confirmed and admin-mapped', () => {
    expect(isAdminConfirmed({ manualOverride: true, matchStatus: 'confirmed' })).toBe(true);
    expect(isAdminConfirmed({ manualOverride: false, matchStatus: 'confirmed' })).toBe(false);
    expect(isAdminConfirmed({ manualOverride: true, matchStatus: 'unconfirmed' })).toBe(false);
  });

  test('isConfirmable: never a mismatch or pending listing, unless admin-mapped', () => {
    for (const status of MATCH_STATUSES) {
      const expected = status !== 'mismatch' && status !== 'pending';
      expect(isConfirmable({ manualOverride: false, matchStatus: status })).toBe(expected);
      expect(isConfirmable({ manualOverride: true, matchStatus: status })).toBe(true);
    }
  });
});
