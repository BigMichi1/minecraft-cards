import { runManager } from '../database/runManager';
import { logError } from '../utils/logger';

/** Send an admin alert under a throttle key; never rejects. */
export type AlertFn = (key: string, text: string) => Promise<void>;

/** An alert with the same key goes out at most once per day. */
export const ALERT_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Wrap `send` so each key alerts at most once per ALERT_EVERY_MS (stored in `admin_alerts`, so
 * it holds across restarts). A failed send gives the slot back, so the next attempt retries.
 * Failures, of the send or of the throttle bookkeeping, are logged, never thrown.
 */
export function throttledAlert(send: (text: string) => Promise<void>, now: () => number): AlertFn {
  return async (key, text) => {
    let previous: number | undefined;
    try {
      previous = runManager.lastAlertAt(key);
      if (!runManager.shouldAlert(key, now(), ALERT_EVERY_MS)) return;
    } catch (error) {
      logError(`admin alert bookkeeping failed (${key})`, error);
      return;
    }
    try {
      await send(text);
    } catch (error) {
      logError(`admin alert failed (${key})`, error, 'warn');
      try {
        runManager.releaseAlert(key, previous);
      } catch (releaseError) {
        logError(`admin alert slot could not be released (${key})`, releaseError);
      }
    }
  };
}
