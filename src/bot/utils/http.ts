import type { FetchFn } from '../shops/types';

export const USER_AGENT = 'minecraft-cards-bot/1.0 (+hourly stock check)';
export const REQUEST_TIMEOUT_MS = 20_000;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
}

/** GET `url` as text with the bot user agent and a 20 s timeout; non-2xx throws `HttpError`. */
export async function fetchText(url: string, fetchFn: FetchFn = fetch): Promise<string> {
  const response = await fetchFn(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new HttpError(response.status, url);
  return await response.text();
}
