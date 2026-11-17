import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db';
import { listingManager } from './listingManager';
import { reports } from './schema/index';

export type ReportReason = 'wrong_number' | 'wrong_series' | 'other';

export const reportManager = {
  /** True when the listing has a report nobody has resolved yet. */
  hasOpenReport(listingId: number): boolean {
    return (
      db
        .select({ id: reports.id })
        .from(reports)
        .where(and(eq(reports.listingId, listingId), isNull(reports.resolvedAt)))
        .get() !== undefined
    );
  },

  /** Store a report and pause the listing, atomically. Returns the report id. */
  create(r: {
    listingId: number;
    reporterId: string;
    reason: ReportReason;
    note: string | null;
    now: number;
  }): number {
    return db.transaction((tx) => {
      const row = tx
        .insert(reports)
        .values({
          listingId: r.listingId,
          reporterId: r.reporterId,
          reason: r.reason,
          note: r.note,
          createdAt: r.now,
        })
        .returning({ id: reports.id })
        .get();
      listingManager.setOnHold(r.listingId);
      return row.id;
    });
  },
};
