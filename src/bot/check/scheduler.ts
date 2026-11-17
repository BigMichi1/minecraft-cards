import logger from '../utils/logger';
import type { RunSummary } from './runner';

export interface Scheduler {
  start(): void;
  stop(): void;
  trigger(): Promise<RunSummary | 'busy'>;
}

/** Runs `run` now and every `intervalMs`; overlapping runs are skipped, never queued. */
export function createScheduler(run: () => Promise<RunSummary>, intervalMs: number): Scheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  async function trigger(): Promise<RunSummary | 'busy'> {
    if (running) return 'busy';
    running = true;
    try {
      return await run();
    } finally {
      running = false;
    }
  }

  async function tick(): Promise<void> {
    try {
      await trigger();
    } catch (error) {
      logger.error(`scheduled check failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => void tick(), intervalMs);
      void tick();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
    trigger,
  };
}
