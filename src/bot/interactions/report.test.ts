import { beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, MessageCreateOptions, ModalSubmitInteraction } from 'discord.js';
import { db, initializeDatabase } from '../database/db';
import { cards, listingCards, listings, reports, adminAlerts } from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import { imageFingerprint, listingManager, type StoredListing } from '../database/listingManager';
import { reportManager } from '../database/reportManager';
import { runManager } from '../database/runManager';
import logger from '../utils/logger';
import {
  buildAdminReportMessage,
  handleReportButton,
  handleReportModal,
  handleReportReason,
  resetReportWarnings,
  retryUnsentReports,
} from './report';
import { cid } from '../../test/cardIds';

let replies: Array<any> = [];
let modals: Array<any> = [];
let edits: Array<any> = [];
let deferrals = 0;

function fakeButton(customId: string) {
  return {
    customId,
    user: { id: 'u1', tag: 'bob#1' },
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    reply: async (p: unknown) => {
      replies.push(p);
    },
    showModal: async (m: unknown) => {
      modals.push(m);
    },
  } as unknown as ButtonInteraction;
}

function fakeModal(customId: string, note: string) {
  const self = {
    customId,
    user: { id: 'u1', tag: 'bob#1' },
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    fields: { getTextInputValue: (_: string) => note },
    reply: async (p: unknown) => {
      replies.push(p);
      (self as any).replied = true;
    },
    deferReply: async () => {
      deferrals += 1;
      (self as any).deferred = true;
    },
    editReply: async (p: unknown) => {
      edits.push(p);
    },
  };
  return self as unknown as ModalSubmitInteraction;
}

const lastReply = () => replies[replies.length - 1];

function makeListing(url = 'https://www.blue-ocean.de/p/12'): StoredListing {
  return listingManager.upsertFromRun(
    'blue-ocean',
    [
      {
        shop: 'blue-ocean',
        url,
        title: 't',
        cardIds: [cid('12')],
        cardName: null,
        imageUrl: 'https://img/12.jpg',
        price: null,
        available: true,
        format: 'shop',
        auctionEndsAt: null,
        idConflict: false,
      },
    ],
    1
  )[0]!;
}

function adminSpy() {
  const calls: MessageCreateOptions[] = [];
  const fn = async (m: MessageCreateOptions) => {
    calls.push(m);
  };
  return Object.assign(fn, { calls });
}

describe('report flow', () => {
  beforeAll(() => {
    initializeDatabase();
  });
  beforeEach(() => {
    replies = [];
    modals = [];
    edits = [];
    deferrals = 0;
    resetReportWarnings();
    db.delete(reports).run();
    db.delete(adminAlerts).run();
    db.delete(listingCards).run();
    db.delete(listings).run();
    db.delete(cards).run();
    catalogManager.seedIfEmpty();
  });

  test('button replies with three reason buttons, ephemeral', async () => {
    const l = makeListing();
    await handleReportButton(fakeButton(`report:${l.id}`));
    const json = lastReply().components[0].toJSON().components;
    expect(json.map((b: any) => b.custom_id)).toEqual([
      `report-reason:${l.id}:wrong_number`,
      `report-reason:${l.id}:wrong_series`,
      `report-reason:${l.id}:other`,
    ]);
    expect(json.map((b: any) => b.label)).toEqual(['Wrong number', 'Wrong series', 'Other']);
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
  });

  test('button for a missing or malformed listing says it no longer exists', async () => {
    await handleReportButton(fakeButton('report:9999'));
    expect(lastReply().content).toBe('This listing no longer exists.');
    await handleReportButton(fakeButton('report:abc'));
    expect(lastReply().content).toBe('This listing no longer exists.');
  });

  test('reason shows a modal with an optional paragraph note', async () => {
    const l = makeListing();
    await handleReportReason(fakeButton(`report-reason:${l.id}:other`));
    const json = modals[0].toJSON();
    expect(json.custom_id).toBe(`report-modal:${l.id}:other`);
    const input = json.components[0].components[0];
    expect(input.custom_id).toBe('note');
    expect(input.required).toBe(false);
    expect(input.max_length).toBe(500);
    expect(input.style).toBe(2);
  });

  test('reason with an unknown reason never throws', async () => {
    const l = makeListing();
    await handleReportReason(fakeButton(`report-reason:${l.id}:bogus`));
    expect(modals).toHaveLength(0);
    expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
  });

  test('modal stores the report, holds the listing, DMs the admin, thanks the user', async () => {
    const l = makeListing();
    const spy = adminSpy();
    await handleReportModal(fakeModal(`report-modal:${l.id}:wrong_series`, ''), spy);
    expect(listingManager.getById(l.id)!.onHold).toBe(true);
    expect(db.select().from(reports).all()[0]!.note).toBeNull();
    const reason = (spy.calls[0]!.embeds![0] as any)
      .toJSON()
      .fields.find((f: any) => f.name === 'Reason').value;
    expect(reason).toBe('Wrong series');
    expect(deferrals).toBe(1);
    expect(replies).toHaveLength(0);
    expect(edits).toHaveLength(1);
    expect(edits[0].content).toContain('admin has been notified');
  });

  test('repeat reports are stored but alert the admin only once until resolved', async () => {
    const l = makeListing();
    const spy = adminSpy();
    await handleReportModal(fakeModal(`report-modal:${l.id}:other`, 'a'), spy);
    await handleReportModal(fakeModal(`report-modal:${l.id}:wrong_number`, 'b'), spy);
    expect(db.select().from(reports).all()).toHaveLength(2);
    expect(spy.calls).toHaveLength(1);
    expect(edits).toHaveLength(2);
    expect(edits[1].content).toContain('admin has been notified');
    db.update(reports).set({ resolvedAt: 5 }).run();
    await handleReportModal(fakeModal(`report-modal:${l.id}:other`, 'c'), spy);
    expect(spy.calls).toHaveLength(2);
  });

  test('a failed admin DM does not silence the next report on the listing', async () => {
    const l = makeListing();
    await handleReportModal(fakeModal(`report-modal:${l.id}:other`, 'a'), async () => {
      throw new Error('dm closed');
    });
    expect(db.select().from(reports).get()!.adminNotifiedAt).toBeNull();
    const spy = adminSpy();
    await handleReportModal(fakeModal(`report-modal:${l.id}:other`, 'b'), spy);
    expect(spy.calls).toHaveLength(1);
    await handleReportModal(fakeModal(`report-modal:${l.id}:other`, 'c'), spy);
    expect(spy.calls).toHaveLength(1);
    const notified = db
      .select()
      .from(reports)
      .all()
      .map((r) => r.adminNotifiedAt !== null);
    expect(notified).toEqual([false, true, false]);
  });

  test('when notifying the admin fails the user is told the truth', async () => {
    const l = makeListing();
    await handleReportModal(fakeModal(`report-modal:${l.id}:other`, 'x'), async () => {
      throw new Error('dm closed');
    });
    expect(db.select().from(reports).all()).toHaveLength(1);
    expect(edits[0].content).not.toContain('admin has been notified');
    expect(edits[0].content).toContain('paused');
    expect(edits[0].content).toContain('try again');
  });

  test('a DM that went out but could not be recorded still thanks the user', async () => {
    const l = makeListing();
    const mark = spyOn(reportManager, 'markAdminNotified').mockImplementation(() => {
      throw new Error('database is locked');
    });
    const log = spyOn(logger, 'log');
    try {
      const spy = adminSpy();
      await handleReportModal(fakeModal(`report-modal:${l.id}:other`, 'x'), spy);
      expect(spy.calls).toHaveLength(1);
      expect(edits[0].content).toContain('admin has been notified');
      expect(
        log.mock.calls.some((c: unknown[]) => String(c[1]).includes('could not be recorded'))
      ).toBe(true);
    } finally {
      mark.mockRestore();
      log.mockRestore();
    }
  });

  describe('retryUnsentReports', () => {
    test('DMs the admin about open reports whose DM failed, once', async () => {
      const l = makeListing();
      await handleReportModal(fakeModal(`report-modal:${l.id}:wrong_number`, 'x'), async () => {
        throw new Error('dm closed');
      });
      const spy = adminSpy();
      expect(await retryUnsentReports(spy)).toBe(1);
      expect(spy.calls).toHaveLength(1);
      expect(db.select().from(reports).get()!.adminNotifiedAt).not.toBeNull();
      expect(await retryUnsentReports(spy)).toBe(0);
      expect(spy.calls).toHaveLength(1);
    });

    test('a failing retry leaves the report for the next run and never throws', async () => {
      const l = makeListing();
      const failing = async () => {
        throw new Error('dm closed');
      };
      await handleReportModal(fakeModal(`report-modal:${l.id}:other`, 'x'), failing);
      expect(await retryUnsentReports(failing)).toBe(0);
      expect(db.select().from(reports).get()!.adminNotifiedAt).toBeNull();
    });

    test('a report whose listing is gone is logged once, not silently skipped', async () => {
      const failing = async () => {
        throw new Error('dm closed');
      };
      const reportId = reportManager.create({
        listingId: 9999,
        reporterId: 'u1',
        reason: 'other',
        note: null,
        now: 1_000,
      });
      const warn = spyOn(logger, 'warn');
      try {
        expect(await retryUnsentReports(failing)).toBe(0);
        expect(await retryUnsentReports(failing)).toBe(0);
        const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
        expect(lines.filter((m) => m.includes(`report ${reportId}`))).toHaveLength(1);
        expect(lines.join('\n')).toContain('listing 9999 no longer exists');
      } finally {
        warn.mockRestore();
      }
    });

    test('a report unsent for over a day warns once per day', async () => {
      const l = makeListing();
      const failing = async () => {
        throw new Error('dm closed');
      };
      const day = 24 * 60 * 60 * 1000;
      const reportId = reportManager.create({
        listingId: l.id,
        reporterId: 'u1',
        reason: 'other',
        note: null,
        now: 1_000,
      });
      const warn = spyOn(logger, 'warn');
      const escalations = () =>
        warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes(`report ${reportId}`));
      try {
        await retryUnsentReports(failing, 1_000 + day - 1);
        expect(escalations()).toHaveLength(0);
        await retryUnsentReports(failing, 1_000 + day);
        expect(escalations()).toHaveLength(1);
        await retryUnsentReports(failing, 1_000 + day + 60_000);
        expect(escalations()).toHaveLength(1);
        await retryUnsentReports(failing, 1_000 + 2 * day + 1);
        expect(escalations()).toHaveLength(2);
      } finally {
        warn.mockRestore();
      }
    });

    test('one report failing its escalation does not skip the reports after it', async () => {
      const listingsOfReports = [makeListing(), makeListing('https://www.blue-ocean.de/p/13')];
      const failing = async () => {
        throw new Error('dm closed');
      };
      const day = 24 * 60 * 60 * 1000;
      const ids = [1_000, 2_000].map((now, n) =>
        reportManager.create({
          listingId: listingsOfReports[n]!.id,
          reporterId: 'u1',
          reason: 'other',
          note: null,
          now,
        })
      );
      const alert = spyOn(runManager, 'shouldAlert').mockImplementationOnce(() => {
        throw new Error('database is locked');
      });
      const warn = spyOn(logger, 'warn');
      const log = spyOn(logger, 'log');
      try {
        await retryUnsentReports(failing, 3_000 + day);
        expect(alert).toHaveBeenCalledTimes(2);
        expect(
          warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes(`report ${ids[1]}`))
        ).toHaveLength(1);
        expect(
          log.mock.calls.some((c: unknown[]) =>
            String(c[1]).startsWith(
              `[REPORT] checking report ${ids[0]} (listing lookup or unsent-warning throttle) failed: database is locked`
            )
          )
        ).toBe(true);
      } finally {
        alert.mockRestore();
        warn.mockRestore();
        log.mockRestore();
      }
    });

    test('a DM that went out but could not be recorded is retried once, then no more', async () => {
      const l = makeListing();
      reportManager.create({
        listingId: l.id,
        reporterId: 'u1',
        reason: 'other',
        note: null,
        now: 1_000,
      });
      const mark = spyOn(reportManager, 'markAdminNotified').mockImplementationOnce(() => {
        throw new Error('database is locked');
      });
      const log = spyOn(logger, 'log');
      try {
        const spy = adminSpy();
        // The DM went out but was not recorded: the next run DMs again (a duplicate is accepted
        // over a lost report), records it, and no run after that sends anything.
        expect(await retryUnsentReports(spy)).toBe(1);
        expect(await retryUnsentReports(spy)).toBe(1);
        expect(await retryUnsentReports(spy)).toBe(0);
        expect(spy.calls).toHaveLength(2);
        expect(db.select().from(reports).get()!.adminNotifiedAt).not.toBeNull();
      } finally {
        mark.mockRestore();
        log.mockRestore();
      }
    });

    test('a resolved report is not retried', async () => {
      const l = makeListing();
      await handleReportModal(fakeModal(`report-modal:${l.id}:other`, 'x'), async () => {
        throw new Error('dm closed');
      });
      listingManager.clearHold(l.url);
      const spy = adminSpy();
      expect(await retryUnsentReports(spy)).toBe(0);
      expect(spy.calls).toHaveLength(0);
    });
  });

  test('modal for a vanished listing or bad id never throws', async () => {
    const spy = adminSpy();
    await handleReportModal(fakeModal('report-modal:9999:other', ''), spy);
    expect(lastReply().content).toBe('This listing no longer exists.');
    await handleReportModal(fakeModal('report-modal:x', ''), spy);
    expect(replies).toHaveLength(2);
    expect(spy.calls).toHaveLength(0);
    expect(db.select().from(reports).all()).toHaveLength(0);
  });

  test('admin message carries Confirm and Dismiss buttons and keeps the command hint', () => {
    const l = makeListing();
    const msg = buildAdminReportMessage(
      { listingId: l.id, reporterId: 'u1', reason: 'wrong_number', note: null },
      l,
      'bob#1'
    );
    expect(msg.components).toHaveLength(1);
    const ids = (msg.components![0] as any).toJSON().components.map((c: any) => c.custom_id);
    expect(ids).toEqual([
      `admin-confirm:${l.id}:12:${imageFingerprint(l.imageUrl)}`,
      `admin-dismiss:${l.id}`,
    ]);
    expect(msg.content).toContain('/admin map url:');
  });

  test('admin message has the fields, commands, and survives a bad listing url', () => {
    const l = { ...makeListing(), url: 'not a url' };
    const msg = buildAdminReportMessage(
      { listingId: l.id, reporterId: 'u1', reason: 'wrong_number', note: 'shows #8' },
      l,
      'bob#1'
    );
    const json = (msg.embeds![0] as any).toJSON();
    expect(json.url).toBeUndefined();
    expect(json.image.url).toBe('https://img/12.jpg');
    const names = json.fields.map((f: any) => f.name);
    expect(names).toEqual(['Reporter', 'Cards', 'Shop', 'URL', 'Reason', 'Note']);
    expect(msg.content).toContain('/admin map url:not a url cards:12');
    expect(msg.content).toContain('/admin clear url:not a url');
  });
});
