import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { db, initializeDatabase } from '../database/db';
import { runManager } from '../database/runManager';
import { adminAlerts } from '../database/schema/index';
import { ALERT_EVERY_MS, throttledAlert } from './adminAlert';

describe('throttledAlert', () => {
  let sent: string[];
  let clock: number;
  beforeAll(() => {
    initializeDatabase();
  });
  beforeEach(() => {
    db.delete(adminAlerts).run();
    sent = [];
    clock = 1_000_000;
  });

  const send = async (text: string) => void sent.push(text);

  test('clips a text over the Discord message limit, so the DM is not rejected', async () => {
    await throttledAlert(send, () => clock)('a', `Shop x check failed: ${'y'.repeat(5000)}`);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2000);
    expect(sent[0]!.startsWith('Shop x check failed: y')).toBe(true);
    expect(sent[0]!.endsWith('…')).toBe(true);
  });

  test('sends each key at most once per day', async () => {
    const alert = throttledAlert(send, () => clock);
    await alert('a', 'one');
    await alert('a', 'two');
    await alert('b', 'three');
    expect(sent).toEqual(['one', 'three']);
    clock += ALERT_EVERY_MS;
    await alert('a', 'four');
    expect(sent).toEqual(['one', 'three', 'four']);
  });

  test('a failed send frees the slot and does not reject', async () => {
    let fail = true;
    const alert = throttledAlert(
      async (text) => {
        if (fail) throw new Error('dms closed');
        sent.push(text);
      },
      () => clock
    );
    await alert('a', 'one');
    expect(runManager.lastAlertAt('a')).toBeUndefined();
    fail = false;
    await alert('a', 'two');
    expect(sent).toEqual(['two']);
  });

  test('a failing throttle store does not reject and sends nothing', async () => {
    const should = spyOn(runManager, 'shouldAlert').mockImplementation(() => {
      throw new Error('database is locked');
    });
    try {
      await throttledAlert(send, () => clock)('a', 'one');
      expect(sent).toEqual([]);
    } finally {
      should.mockRestore();
    }
  });

  test('a failing release after a failed send does not reject', async () => {
    const release = spyOn(runManager, 'releaseAlert').mockImplementation(() => {
      throw new Error('database is locked');
    });
    try {
      const alert = throttledAlert(
        async () => {
          throw new Error('down');
        },
        () => clock
      );
      await alert('a', 'one');
      expect(release).toHaveBeenCalled();
    } finally {
      release.mockRestore();
    }
  });
});
