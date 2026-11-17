import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from './db';
import { listingManager } from './listingManager';
import { reports } from './schema/index';

export type ReportReason = 'wrong_number' | 'wrong_series' | 'other';

export const reportManager = {
  /**
   * True when the listing has an unresolved report the admin was told about. An open report
   * whose admin DM failed does not count, so the next report on the listing DMs again.
   */
  hasNotifiedOpenReport(listingId: number): boolean {
    return (
      db
        .select({ id: reports.id })
        .from(reports)
        .where(
          and(
            eq(reports.listingId, listingId),
            isNull(reports.resolvedAt),
            isNotNull(reports.adminNotifiedAt)
          )
        )
        .get() !== undefined
    );
  },

  markAdminNotified(reportId: number, now: number): void {
    db.update(reports).set({ adminNotifiedAt: now }).where(eq(reports.id, reportId)).run();
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
