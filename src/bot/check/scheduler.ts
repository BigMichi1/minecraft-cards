import logger from '../utils/logger';
import type { RunSummary } from './runner';

export interface Scheduler {
  start(): void;
  /** Stops the timer; resolves once the in-flight run (if any) has finished, never rejects. */
  stop(): Promise<void>;
  trigger(): Promise<RunSummary | 'busy'>;
}

/** Runs `run` now and every `intervalMs`; overlapping runs are skipped, never queued. */
export function createScheduler(run: () => Promise<RunSummary>, intervalMs: number): Scheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let current: Promise<RunSummary> | null = null;

  async function trigger(): Promise<RunSummary | 'busy'> {
    if (current) return 'busy';
    const started = run();
    current = started;
    try {
      return await started;
    } finally {
      current = null;
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
    async stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      // The run logs its own failure (tick) or hands it to the /admin run caller.
      await current?.catch(() => undefined);
    },
    trigger,
  };
}
