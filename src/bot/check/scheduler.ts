import { logError } from '../utils/logger';
import type { RunSummary } from './runner';

export interface Scheduler {
  start(): void;
  /** Stops the timer; resolves once the in-flight run (if any) has finished, never rejects. */
  stop(): Promise<void>;
  /** Run now: `busy` while a run is in progress, `stopping` once stop() was called. */
  trigger(): Promise<RunSummary | 'busy' | 'stopping'>;
}

/** Runs `run` now and every `intervalMs`; overlapping runs are skipped, never queued. */
export function createScheduler(run: () => Promise<RunSummary>, intervalMs: number): Scheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let current: Promise<RunSummary> | null = null;
  let stopped = false;

  async function trigger(): Promise<RunSummary | 'busy' | 'stopping'> {
    if (stopped) return 'stopping';
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
      // runCheck records its own failures; this is a failure to record the run itself.
      logError('scheduled check failed', error);
    }
  }

  return {
    start() {
      if (timer !== undefined || stopped) return;
      timer = setInterval(() => void tick(), intervalMs);
      void tick();
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      // The run logs its own failure (tick) or hands it to the /admin run caller.
      await current?.catch(() => undefined);
    },
    trigger,
  };
}
