import { describe, expect, test } from 'bun:test';
import {
  CONFIRM_PREFIX,
  DISMISS_PREFIX,
  RIGHT_PREFIX,
  decodeConfirmId,
  decodeDismissId,
  decodeRightId,
  encodeConfirmId,
  encodeDismissId,
  encodeRightId,
  imageFingerprint,
  parseListingId,
  decodeRemovalId,
  encodeKeepId,
  encodeRemoveId,
} from './buttonIds';
import { cid } from '../../test/cardIds';

describe('parseListingId', () => {
  test('accepts 1 to 15 digits only', () => {
    expect(parseListingId('42')).toBe(42);
    expect(parseListingId('1'.repeat(15))).toBe(111111111111111);
    for (const bad of [undefined, '', 'x', '-1', '1.5', '1'.repeat(16)]) {
      expect(parseListingId(bad)).toBeNull();
    }
  });
});

describe('Right ids', () => {
  test('round trip', () => {
    expect(encodeRightId(7)).toBe('right:7');
    expect(encodeRightId(7).startsWith(RIGHT_PREFIX)).toBe(true);
    expect(decodeRightId('right:7')).toBe(7);
  });
  test.each(['right:', 'right:x', 'right:1:2', 'rights:1', 'report:1'])('rejects %p', (id) => {
    expect(decodeRightId(id)).toBeNull();
  });
});

describe('Dismiss ids', () => {
  test('round trip', () => {
    expect(encodeDismissId(9)).toBe('admin-dismiss:9');
    expect(encodeDismissId(9).startsWith(DISMISS_PREFIX)).toBe(true);
    expect(decodeDismissId('admin-dismiss:9')).toBe(9);
  });
  test.each(['admin-dismiss:', 'admin-dismiss:x', 'admin-dismiss:1:2'])('rejects %p', (id) => {
    expect(decodeDismissId(id)).toBeNull();
  });
});

describe('Confirm ids', () => {
  const listing = { id: 5, cardIds: [cid('12'), cid('LE8')], imageUrl: 'https://img/5.jpg' };

  test('round trip carries cards and the picture fingerprint', () => {
    const id = encodeConfirmId(listing)!;
    expect(id).toBe(`admin-confirm:5:12,LE8:${imageFingerprint(listing.imageUrl)}`);
    expect(id.startsWith(CONFIRM_PREFIX)).toBe(true);
    expect(decodeConfirmId(id)).toEqual({
      listingId: 5,
      cardIds: [cid('12'), cid('LE8')],
      image: imageFingerprint(listing.imageUrl),
    });
  });

  test('card ids are read canonically and kept as written, repeats included', () => {
    const image = imageFingerprint(listing.imageUrl);
    expect(decodeConfirmId(`admin-confirm:5:012,le8:${image}`)?.cardIds).toEqual([
      cid('12'),
      cid('LE8'),
    ]);
    // confirmCards compares sets, so a repeat cannot confirm other cards.
    expect(decodeConfirmId(`admin-confirm:5:12,12:${image}`)?.cardIds).toEqual([
      cid('12'),
      cid('12'),
    ]);
  });

  test('no cards gives no id', () => {
    expect(encodeConfirmId({ ...listing, cardIds: [] })).toBeNull();
  });

  test('an id of exactly 100 characters is kept, 101 is not', () => {
    const cards = (n: number) => Array.from({ length: n }, () => cid('1'));
    // Find a listing id and a card count whose Confirm id is exactly 100 characters.
    for (let digits = 1; digits <= 6; digits++) {
      for (let n = 1; n <= 50; n++) {
        const id = Number('1'.repeat(digits));
        const at100 = encodeConfirmId({ ...listing, id, cardIds: cards(n) });
        if (at100?.length !== 100) continue;
        const at101 = encodeConfirmId({ ...listing, id: id * 10 + 1, cardIds: cards(n) });
        expect(at101).toBeNull();
        return;
      }
    }
    throw new Error('no combination reached exactly 100 characters');
  });

  test.each([
    'admin-confirm:5:12',
    'admin-confirm:x:12:abc',
    'admin-confirm:5::abc',
    'admin-confirm:5:??:abc',
    'admin-confirm:5:12:',
    'admin-confirm:5:12:ABC',
    'admin-confirm:5:12:abcdefghijklmn',
  ])('rejects %p', (id) => {
    expect(decodeConfirmId(id)).toBeNull();
  });
});

describe('catalog removal ids', () => {
  test('carry the token after their prefix and are read back', () => {
    expect(encodeRemoveId('abc')).toBe('catalog-remove:abc');
    expect(encodeKeepId('abc')).toBe('catalog-keep:abc');
    expect(decodeRemovalId('catalog-remove:abc')).toEqual({ remove: true, token: 'abc' });
    expect(decodeRemovalId('catalog-keep:abc')).toEqual({ remove: false, token: 'abc' });
    expect(decodeRemovalId('catalog-save:abc')).toBeNull();
  });
});
