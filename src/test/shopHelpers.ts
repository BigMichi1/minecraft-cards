import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchFn } from '../bot/shops/types';

export function readFixture(name: string): string {
  return readFileSync(join(import.meta.dir, './fixtures', name), 'utf8');
}

/**
 * Fake fetch: a key the requested url ends with wins, else the first key it contains.
 * Unmatched urls answer 404. Records every requested url.
 */
export function fakeFetch(pages: Record<string, string>): { fetchFn: FetchFn; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url) => {
    calls.push(url);
    const keys = Object.keys(pages);
    const key = keys.find((k) => url.endsWith(k)) ?? keys.find((k) => url.includes(k));
    if (key === undefined) return new Response('not found', { status: 404 });
    return new Response(pages[key]);
  };
  return { fetchFn, calls };
}
