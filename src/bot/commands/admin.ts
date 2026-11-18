import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { formatCardList } from '../cards/cardId';
import { parseChecklist } from '../cards/starterCatalog';
import type { PictureCounts, RunSummary } from '../check/runner';
import { PICTURE_REJECTIONS, type PictureRejection } from '../matcher/matchStatus';
import { catalogManager, parseKnownCardList } from '../database/catalogManager';
import { listingManager, type StoredListing } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { buildPreviewText, importStore } from '../interactions/catalogImport';
import { errorMessage } from '../utils/async';
import { replyWithError } from '../utils/interactionReply';
import { logError } from '../utils/logger';
import { DISCORD_MESSAGE_LIMIT, joinWithinLimit } from '../utils/messageLimit';

const LIST_OPTION_MAX_LENGTH = 6000;

export interface AdminContext {
  adminId: string;
  trigger: () => Promise<RunSummary | 'busy' | 'stopping'>;
}

export const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Bot administration')
  // Hidden from non-administrators in the command picker; execute() still checks adminId.
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('map')
      .setDescription('Set the cards of a stored listing')
      .addStringOption((o) => o.setName('url').setDescription('Listing URL').setRequired(true))
      .addStringOption((o) =>
        o.setName('cards').setDescription('Card numbers, e.g. 12, LE8').setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('clear')
      .setDescription('Lift the hold on a listing and resolve its reports')
      .addStringOption((o) => o.setName('url').setDescription('Listing URL').setRequired(true))
  )
  .addSubcommand((sub) =>
    sub.setName('status').setDescription('Show the last check run and listings on hold')
  )
  .addSubcommand((sub) => sub.setName('run').setDescription('Run a check now'))
  .addSubcommandGroup((group) =>
    group
      .setName('catalog')
      .setDescription('Manage the card catalog')
      .addSubcommand((sub) =>
        sub
          .setName('import')
          .setDescription('Import a pasted laststicker checklist')
          .addStringOption((o) =>
            o
              .setName('list')
              .setDescription('The pasted checklist')
              .setRequired(true)
              .setMaxLength(LIST_OPTION_MAX_LENGTH)
          )
      )
  );

const ephemeral = (content: string) => ({ content, flags: MessageFlags.Ephemeral as const });

const REJECTION_TEXT: Record<PictureRejection, string> = {
  undecided: 'undecided',
  puzzle: 'puzzle',
  twin: 'twin',
  incomplete: 'incomplete reference set',
  title_fits: 'title card fits too',
};

/** `Pictures: 3 decided · not counted: 5 undecided, 1 puzzle` (zero counts left out). */
function picturesLine(pictures: PictureCounts): string {
  const rejected = PICTURE_REJECTIONS.filter((r) => pictures[r]).map(
    (r) => `${pictures[r]} ${REJECTION_TEXT[r]}`
  );
  return `Pictures: ${pictures.decided ?? 0} decided${rejected.length > 0 ? ` · not counted: ${rejected.join(', ')}` : ''}`;
}

export function formatSummary(summary: RunSummary): string {
  const lines = Object.entries(summary.shops).map(([shop, s]) => {
    let line = `${shop}: ${s.listings} listings`;
    if (s.error) line += ` — error: ${s.error}`;
    if (s.skippedNoId) line += ` (skipped ${s.skippedNoId} without card number)`;
    if (s.skippedExcluded) line += ` (skipped ${s.skippedExcluded} not series 3 single cards)`;
    if (s.truncated) {
      line += ` (${s.truncated} ${s.truncated === 1 ? 'search' : 'searches'} cut at the page cap)`;
    }
    if (s.skippedInvalid) line += ` (skipped ${s.skippedInvalid} without link or title)`;
    return line;
  });
  if (summary.error) lines.push(`Run failed: ${summary.error}`);
  if (summary.pictures) lines.push(picturesLine(summary.pictures));
  lines.push(`Notified: ${summary.notified} · DM failures: ${summary.dmFailures}`);
  return lines.join('\n').slice(0, DISCORD_MESSAGE_LIMIT);
}

const MAX_HOLDS_SHOWN = 10;

/** `On hold: N listings` and up to 10 `url (#ids)` lines, cut to what fits in `room`. */
function holdsText(held: StoredListing[], room: number): string {
  let text = `On hold: ${held.length} listings`;
  let shown = 0;
  for (const l of held.slice(0, MAX_HOLDS_SHOWN)) {
    const ids = l.cardIds.map((id) => `#${id}`).join(', ') || 'no cards';
    const line = `\n- ${l.url} (${ids})`;
    const rest = held.length - shown - 1;
    const tail = rest > 0 ? `\n… and ${rest} more` : '';
    if (text.length + line.length + tail.length > room) break;
    text += line;
    shown++;
  }
  if (shown < held.length) text += `\n… and ${held.length - shown} more`;
  return text.slice(0, room);
}

function statusText(): string {
  const last = runManager.last();
  const run = last
    ? `Last run: <t:${Math.floor(last.finishedAt / 1000)}:R>\n${formatSummary(last)}`
    : 'No check has run yet.';
  const held = listingManager.onHold();
  if (held.length === 0) return run.slice(0, DISCORD_MESSAGE_LIMIT);
  // With holds to list, the run summary may take at most half, so the holds always get room.
  const head = run.slice(0, DISCORD_MESSAGE_LIMIT / 2);
  return `${head}\n\n${holdsText(held, DISCORD_MESSAGE_LIMIT - head.length - 2)}`;
}

function mapCards(url: string, cardsInput: string): string {
  const parsed = parseKnownCardList(cardsInput);
  if (!parsed.ok) {
    return parsed.reason === 'empty'
      ? 'No card numbers found. Example: 12, LE8'
      : joinWithinLimit('Nothing changed. Unknown or invalid: ', [...new Set(parsed.invalid)]);
  }
  const listing = listingManager.overrideCards(url, parsed.ids, Date.now());
  if (!listing) return 'No stored listing with that URL.';
  return joinWithinLimit('Listing now maps to: ', formatCardList(listing.cardIds).split(', '));
}

async function importCatalog(interaction: ChatInputCommandInteraction): Promise<void> {
  const { ids, invalid } = parseChecklist(interaction.options.getString('list', true));
  if (invalid.length > 0) {
    await interaction.reply(
      ephemeral(joinWithinLimit('Nothing stored. Invalid tokens: ', [...new Set(invalid)]))
    );
    return;
  }
  if (ids.length === 0) {
    await interaction.reply(ephemeral('No card ids found. Nothing changed.'));
    return;
  }
  const token = importStore.put(ids);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`catalog-save:${token}`)
      .setLabel('Save')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`catalog-cancel:${token}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
  );
  await interaction.reply({
    content: buildPreviewText(catalogManager.previewImport(ids)),
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: AdminContext
): Promise<void> {
  if (interaction.user.id !== ctx.adminId) {
    await interaction.reply(ephemeral('Only the bot admin can use this.'));
    return;
  }
  try {
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();
    if (group === 'catalog' && sub === 'import') {
      await importCatalog(interaction);
      return;
    }
    switch (sub) {
      case 'map':
        await interaction.reply(
          ephemeral(
            mapCards(
              interaction.options.getString('url', true),
              interaction.options.getString('cards', true)
            )
          )
        );
        return;
      case 'clear': {
        const listing = listingManager.clearHold(interaction.options.getString('url', true));
        await interaction.reply(
          ephemeral(
            listing ? 'Hold lifted and reports resolved.' : 'No stored listing with that URL.'
          )
        );
        return;
      }
      case 'status':
        await interaction.reply(ephemeral(statusText()));
        return;
      case 'run': {
        // A check takes minutes (shops + images); acknowledge within Discord's 3 s window.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let content: string;
        try {
          const result = await ctx.trigger();
          content =
            result === 'busy'
              ? 'A check is already running.'
              : result === 'stopping'
                ? 'The bot is shutting down; no check was started.'
                : formatSummary(result);
        } catch (error) {
          logError('[ADMIN COMMAND] /admin run failed', error);
          content = `Check failed: ${errorMessage(error)}`.slice(0, DISCORD_MESSAGE_LIMIT);
        }
        await interaction.editReply({ content });
        return;
      }
      default:
        throw new Error(`Unknown /admin subcommand: ${sub}`);
    }
  } catch (error) {
    logError('[ADMIN COMMAND] failed', error);
    await replyWithError(interaction, 'Error', 'Something went wrong running the admin command.');
  }
}
