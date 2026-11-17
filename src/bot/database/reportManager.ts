import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from './db';
import { listingManager } from './listingManager';
import { reports, type Report } from './schema/index';

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

  /**
   * Open reports the admin has not heard of: per listing without a notified open report, its
   * latest unresolved report whose DM failed. Oldest listing first.
   */
  unsentOpen(): Report[] {
    const open = db
      .select()
      .from(reports)
      .where(isNull(reports.resolvedAt))
      .orderBy(desc(reports.id))
      .all();
    const notified = new Set(
      open.filter((r) => r.adminNotifiedAt !== null).map((r) => r.listingId)
    );
    const latest = new Map<number, Report>();
    for (const r of open) {
      if (!notified.has(r.listingId) && !latest.has(r.listingId)) latest.set(r.listingId, r);
    }
    return [...latest.values()].sort((a, b) => a.listingId - b.listingId);
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
