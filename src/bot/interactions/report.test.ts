import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, MessageCreateOptions, ModalSubmitInteraction } from 'discord.js';
import { db, initializeDatabase } from '../database/db';
import { cards, listingCards, listings, reports } from '../database/schema/index';
import { catalogManager } from '../database/catalogManager';
import { listingManager, type StoredListing } from '../database/listingManager';
import {
  buildAdminReportMessage,
  handleReportButton,
  handleReportModal,
  handleReportReason,
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
    db.delete(reports).run();
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

  test('modal still thanks the user when notifying the admin fails', async () => {
    const l = makeListing();
    await handleReportModal(fakeModal(`report-modal:${l.id}:other`, 'x'), async () => {
      throw new Error('dm closed');
    });
    expect(db.select().from(reports).all()).toHaveLength(1);
    expect(edits[0].content).toContain('admin has been notified');
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
