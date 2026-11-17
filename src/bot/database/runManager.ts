import { desc, eq } from 'drizzle-orm';
import type { RunSummary } from '../check/runner';
import { db } from './db';
import { adminAlerts, runs } from './schema/index';

export const runManager = {
  record(summary: RunSummary): void {
    db.insert(runs)
      .values({
        startedAt: summary.startedAt,
        finishedAt: summary.finishedAt,
        summary: JSON.stringify(summary),
      })
      .run();
  },

  last(): RunSummary | undefined {
    const row = db.select().from(runs).orderBy(desc(runs.id)).limit(1).get();
    return row ? (JSON.parse(row.summary) as RunSummary) : undefined;
  },

  /** True (and remembers `now`) when no alert with this key went out within `everyMs`. */
  shouldAlert(key: string, now: number, everyMs: number): boolean {
    return db.transaction((tx) => {
      const row = tx.select().from(adminAlerts).where(eq(adminAlerts.key, key)).get();
      if (row && now - row.lastSentAt < everyMs) return false;
      tx.insert(adminAlerts)
        .values({ key, lastSentAt: now })
        .onConflictDoUpdate({ target: adminAlerts.key, set: { lastSentAt: now } })
        .run();
      return true;
    });
  },
};
