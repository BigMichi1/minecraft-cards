import { describe, expect, test } from 'bun:test';
import { imageFingerprint } from './imageFingerprint';

describe('imageFingerprint', () => {
  test('is short, stable and tells picture URLs apart', () => {
    const a = imageFingerprint('https://img/a.jpg');
    expect(a).toBe(imageFingerprint('https://img/a.jpg'));
    expect(a).not.toBe(imageFingerprint('https://img/b.jpg'));
    expect(a).toMatch(/^[0-9a-z]{1,13}$/);
  });

  test('no picture URL has one fingerprint, the same as an empty one', () => {
    expect(imageFingerprint(null)).toBe(imageFingerprint(''));
    expect(imageFingerprint(null)).not.toBe(imageFingerprint('https://img/a.jpg'));
  });
});
