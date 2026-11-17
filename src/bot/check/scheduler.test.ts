import { describe, expect, spyOn, test } from 'bun:test';
import logger from '../utils/logger';
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
    // Poll instead of one fixed sleep: timers run late on a loaded machine.
    for (let i = 0; i < 300 && calls < 3; i++) await Bun.sleep(10);
    await sched.stop();
    const seen = calls;
    expect(seen).toBeGreaterThanOrEqual(3);
    await Bun.sleep(40);
    expect(calls).toBe(seen);
  });

  test('stop resolves only after the in-flight run has finished', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let finished = false;
    const sched = createScheduler(async () => {
      await gate;
      finished = true;
      return summary;
    }, 60_000);
    const run = sched.trigger();
    let stopped = false;
    const stopping = sched.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(20);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
    expect(await run).toBe(summary);
  });

  test('stop resolves at once when idle and swallows a failing run', async () => {
    const idle = createScheduler(async () => summary, 60_000);
    await idle.stop();
    const failing = createScheduler(async () => {
      await Bun.sleep(5);
      throw new Error('boom');
    }, 60_000);
    const run = failing.trigger().catch((e: unknown) => e);
    await failing.stop();
    expect(await run).toBeInstanceOf(Error);
  });

  test('trigger after stop does not start a run', async () => {
    let calls = 0;
    const sched = createScheduler(async () => {
      calls++;
      return summary;
    }, 60_000);
    await sched.stop();
    expect(await sched.trigger()).toBe('stopping');
    expect(calls).toBe(0);
  });

  test('a failing scheduled run is logged with its stack', async () => {
    const log = spyOn(logger, 'log');
    try {
      const sched = createScheduler(async () => {
        throw new Error('boom');
      }, 60_000);
      sched.start();
      for (let i = 0; i < 100 && log.mock.calls.length === 0; i++) await Bun.sleep(5);
      await sched.stop();
      const call = (log.mock.calls as unknown[][]).find((c) =>
        String(c[1]).includes('scheduled check failed: boom')
      );
      expect(call?.[2]).toHaveProperty('stack');
    } finally {
      log.mockRestore();
    }
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
    await sched.stop();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});
