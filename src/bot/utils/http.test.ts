import { describe, test, expect } from 'bun:test';
import { fetchText, HttpError, USER_AGENT, REQUEST_TIMEOUT_MS } from './http';
import type { FetchFn } from '../shops/types';

describe('fetchText', () => {
  test('returns the body and sends the bot user agent and a timeout signal', async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchFn: FetchFn = async (url, init) => {
      seen = { url, init };
      return new Response('hello');
    };
    expect(await fetchText('https://example.test/a', fetchFn)).toBe('hello');
    expect(seen?.url).toBe('https://example.test/a');
    expect(new Headers(seen?.init?.headers).get('user-agent')).toBe(USER_AGENT);
    expect(USER_AGENT).toBe('minecraft-cards-bot/1.0 (+hourly stock check)');
    expect(REQUEST_TIMEOUT_MS).toBe(20_000);
    expect(seen?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('throws HttpError with status and url on non-2xx', async () => {
    const fetchFn: FetchFn = async () => new Response('nope', { status: 503 });
    const error = await fetchText('https://example.test/b', fetchFn).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect((error as HttpError).url).toBe('https://example.test/b');
    expect((error as HttpError).message).toContain('503');
  });

  test('propagates network failures', async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error('connection reset');
    };
    await expect(fetchText('https://example.test/c', fetchFn)).rejects.toThrow('connection reset');
  });
});
