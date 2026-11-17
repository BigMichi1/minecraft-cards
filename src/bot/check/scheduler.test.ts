import { describe, expect, test } from 'bun:test';
import { createScheduler } from './scheduler';
import type { RunSummary } from './runner';

const summary: RunSummary = { startedAt: 0, finishedAt: 0, shops: {}, notified: 0, dmFailures: 0 };

describe('createScheduler', () => {
  test('trigger returns busy while a run is in progress', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const sched = createScheduler(async () => {
      calls++;
      await gate;
      return summary;
    }, 60_000);
    const first = sched.trigger();
    expect(await sched.trigger()).toBe('busy');
    release();
    expect(await first).toBe(summary);
    expect(calls).toBe(1);
    expect(await sched.trigger()).toBe(summary);
  });

  test('start runs immediately then on every interval until stop', async () => {
    let calls = 0;
    const sched = createScheduler(async () => {
      calls++;
      return summary;
    }, 10);
    sched.start();
    await Bun.sleep(65);
    sched.stop();
    const seen = calls;
    expect(seen).toBeGreaterThanOrEqual(3);
    await Bun.sleep(40);
    expect(calls).toBe(seen);
  });

  test('a tick during a slow run is skipped and a failing run does not stop the timer', async () => {
    let calls = 0;
    const sched = createScheduler(async () => {
      calls++;
      await Bun.sleep(35);
      if (calls === 1) throw new Error('boom');
      return summary;
    }, 10);
    sched.start();
    await Bun.sleep(30);
    expect(calls).toBe(1);
    await Bun.sleep(80);
    sched.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
