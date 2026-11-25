import { describe, expect, test } from 'bun:test';
import { readAvailability } from './schemaOrg';

describe('readAvailability', () => {
  test('reads schema.org availability in any spelling of its URL', () => {
    expect(readAvailability('https://schema.org/InStock')).toBe(true);
    expect(readAvailability('http://schema.org/InStock')).toBe(true);
    expect(readAvailability('//www.schema.org/LimitedAvailability')).toBe(true);
    expect(readAvailability(' InStock ')).toBe(true);
    expect(readAvailability('http://schema.org/OutOfStock')).toBe(false);
    expect(readAvailability('https://schema.org/PreOrder')).toBe(false);
  });

  test('an unknown value is null, never in or out of stock', () => {
    expect(readAvailability('https://schema.org/Maybe')).toBeNull();
    expect(readAvailability('https://example.com/InStock')).toBeNull();
    expect(readAvailability('')).toBeNull();
  });
});
