import type { FetchFn } from '../shops/types';
import { sleep as realSleep } from './async';

/**
 * A fetch that keeps at least `delayMs` between two requests to any of `hosts` (laststicker's
 * scans: at most one request per 1500 ms, as the shops' pages), serialized through one queue so
 * concurrent callers (the reference loader embeds several pictures at once) wait their turn.
 * Requests to other hosts, and URLs that do not parse, pass through at once. A failed request
 * counts as a request: the next one still waits.
 */
export function createPacedFetch(
  fetchFn: FetchFn,
  hosts: ReadonlySet<string>,
  delayMs: number,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}
): FetchFn {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  let queue: Promise<unknown> = Promise.resolve();
  let lastAt: number | undefined;
  return (url, init) => {
    const host = URL.parse(url)?.hostname;
    if (host === undefined || !hosts.has(host)) return fetchFn(url, init);
    const turn = queue.then(async () => {
      if (lastAt !== undefined) {
        const wait = lastAt + delayMs - now();
        if (wait > 0) await sleep(wait);
      }
      lastAt = now();
    });
    queue = turn;
    return turn.then(() => fetchFn(url, init));
  };
}
