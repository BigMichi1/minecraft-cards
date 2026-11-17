import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type { ButtonInteraction, MessageCreateOptions, ModalSubmitInteraction } from 'discord.js';
import { catalogManager } from '../database/catalogManager';
import { listingManager, type StoredListing } from '../database/listingManager';
import { reportManager, type ReportReason } from '../database/reportManager';
import { validUrl } from '../notify/messages';
import logger, { logError } from '../utils/logger';
import { replyWithError } from '../utils/interactionReply';

const REASONS: Record<ReportReason, string> = {
  wrong_number: 'Wrong number',
  wrong_series: 'Wrong series',
  other: 'Other',
};
const MAX_NOTE = 500;
const MAX_FIELD = 1024;
const NO_LISTING = 'This listing no longer exists.';
const THANKS = "Thanks — the admin has been notified. This listing is paused until it's checked.";
const THANKS_UNSENT =
  "Thanks — this listing is paused until it's checked. The admin could not be reached just now; the bot will try again with the next check.";

type NotifyAdmin = (msg: MessageCreateOptions) => Promise<void>;

/**
 * DM the admin about one report and record it. True when the DM went out (even if recording
 * it then failed: the admin knows, at worst the next check DMs again).
 */
async function sendReport(
  notifyAdmin: NotifyAdmin,
  report: {
    id: number;
    listingId: number;
    reporterId: string;
    reason: ReportReason;
    note: string | null;
  },
  listing: StoredListing,
  reporterTag: string
): Promise<boolean> {
  try {
    await notifyAdmin(buildAdminReportMessage(report, listing, reporterTag));
  } catch (err) {
    logError(
      `[REPORT] Could not notify the admin of report ${report.id} on listing ${listing.id}`,
      err
    );
    return false;
  }
  try {
    reportManager.markAdminNotified(report.id, Date.now());
  } catch (err) {
    logError(
      `[REPORT] The admin DM for report ${report.id} went out but could not be recorded`,
      err
    );
  }
  return true;
}

function isReason(value: string | undefined): value is ReportReason {
  return value !== undefined && Object.hasOwn(REASONS, value);
}

function parseListingId(value: string | undefined): number | null {
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

/** Parse `<prefix>:<listingId>[:<reason>]`; null when malformed. */
function parseId(
  customId: string,
  withReason: boolean
): { listingId: number; reason: ReportReason | null } | null {
  const parts = customId.split(':');
  if (parts.length !== (withReason ? 3 : 2)) return null;
  const listingId = parseListingId(parts[1]);
  if (listingId === null) return null;
  if (!withReason) return { listingId, reason: null };
  return isReason(parts[2]) ? { listingId, reason: parts[2] } : null;
}

const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral as const });

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export async function handleReportButton(i: ButtonInteraction): Promise<void> {
  try {
    const parsed = parseId(i.customId, false);
    if (!parsed || !listingManager.getById(parsed.listingId)) {
      await i.reply(ephemeral(NO_LISTING));
      return;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      (Object.keys(REASONS) as ReportReason[]).map((reason) =>
        new ButtonBuilder()
          .setCustomId(`report-reason:${parsed.listingId}:${reason}`)
          .setLabel(REASONS[reason])
          .setStyle(ButtonStyle.Secondary)
      )
    );
    await i.reply({
      content: 'What is wrong with this listing?',
      components: [row],
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    logError('[REPORT] button failed', err);
    await replyWithError(i, 'Report failed', 'Something went wrong. Please try again later.');
  }
}

export async function handleReportReason(i: ButtonInteraction): Promise<void> {
  try {
    const parsed = parseId(i.customId, true);
    if (!parsed?.reason) {
      await i.reply(ephemeral('Something went wrong. Please try again.'));
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId(`report-modal:${parsed.listingId}:${parsed.reason}`)
      .setTitle('Report a wrong card')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('note')
            .setLabel('Note (optional)')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(MAX_NOTE)
        )
      );
    await i.showModal(modal);
  } catch (err) {
    logError('[REPORT] reason failed', err);
    await replyWithError(i, 'Report failed', 'Something went wrong. Please try again later.');
  }
}

export function buildAdminReportMessage(
  report: { listingId: number; reporterId: string; reason: ReportReason; note: string | null },
  listing: StoredListing,
  reporterTag: string
): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setTitle(`⚠️ Wrong card reported (listing ${report.listingId})`)
    .addFields(
      {
        name: 'Reporter',
        value: truncate(`${reporterTag} (${report.reporterId})`, MAX_FIELD),
        inline: true,
      },
      {
        name: 'Cards',
        value: truncate(listing.cardIds.map((id) => `#${id}`).join(', ') || 'none', MAX_FIELD),
        inline: true,
      },
      { name: 'Shop', value: listing.shop, inline: true },
      { name: 'URL', value: truncate(listing.url, MAX_FIELD) },
      { name: 'Reason', value: REASONS[report.reason], inline: true }
    );
  if (report.note) embed.addFields({ name: 'Note', value: truncate(report.note, MAX_FIELD) });
  const url = validUrl(listing.url);
  if (url) embed.setURL(url);
  const image = validUrl(listing.imageUrl);
  if (image) embed.setImage(image);
  const reference = listing.cardIds[0] ? catalogManager.getCard(listing.cardIds[0]) : undefined;
  const thumbnail = validUrl(reference?.referenceImageUrl);
  if (thumbnail) embed.setThumbnail(thumbnail);
  const ids = listing.cardIds.join(',');
  return {
    content: truncate(
      `Fix with \`/admin map url:${listing.url} cards:${ids}\` or dismiss with \`/admin clear url:${listing.url}\`.`,
      2000
    ),
    embeds: [embed],
  };
}

export async function handleReportModal(
  i: ModalSubmitInteraction,
  notifyAdmin: NotifyAdmin
): Promise<void> {
  try {
    const parsed = parseId(i.customId, true);
    const listing = parsed ? listingManager.getById(parsed.listingId) : undefined;
    if (!parsed?.reason || !listing) {
      await i.reply(ephemeral(NO_LISTING));
      return;
    }
    // Acknowledge first: the DB write and the admin DM must not eat the 3 s window.
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const note = i.fields.getTextInputValue('note').trim() || null;
    const report = {
      listingId: listing.id,
      reporterId: i.user.id,
      reason: parsed.reason,
      note,
    };
    // Checked before inserting: the admin hears once per open hold, unless that DM failed.
    const alreadyNotified = reportManager.hasNotifiedOpenReport(listing.id);
    const reportId = reportManager.create({ ...report, now: Date.now() });
    const adminKnows =
      alreadyNotified ||
      (await sendReport(
        notifyAdmin,
        { ...report, id: reportId },
        listing,
        i.user.tag ?? i.user.username
      ));
    await i.editReply({ content: adminKnows ? THANKS : THANKS_UNSENT });
  } catch (err) {
    logError('[REPORT] modal failed', err);
    await replyWithError(i, 'Report failed', 'Something went wrong. Please try again later.');
  }
}

/**
 * Retry the admin DM of open reports whose DM failed (reportManager.unsentOpen); called every
 * check run. Returns how many went out; never throws.
 */
export async function retryUnsentReports(notifyAdmin: NotifyAdmin): Promise<number> {
  let sent = 0;
  try {
    for (const report of reportManager.unsentOpen()) {
      const listing = listingManager.getById(report.listingId);
      if (!listing) continue;
      if (await sendReport(notifyAdmin, report, listing, report.reporterId)) sent++;
    }
  } catch (err) {
    logError('[REPORT] retrying unsent reports failed', err);
  }
  if (sent > 0) logger.info(`[REPORT] sent ${sent} report DMs that had failed before`);
  return sent;
}
