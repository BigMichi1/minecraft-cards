import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  SlashCommandBuilder,
} from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { formatCardList, parseCardList } from '../cards/cardId';
import { parseChecklist } from '../cards/starterCatalog';
import type { RunSummary } from '../check/runner';
import { catalogManager } from '../database/catalogManager';
import { listingManager } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { buildPreviewText, importStore } from '../interactions/catalogImport';
import { errorMessage } from '../utils/async';
import { replyWithError } from '../utils/interactionReply';
import logger from '../utils/logger';
import { DISCORD_MESSAGE_LIMIT, joinWithinLimit } from '../utils/messageLimit';

const LIST_OPTION_MAX_LENGTH = 6000;

export interface AdminContext {
  adminId: string;
  trigger: () => Promise<RunSummary | 'busy'>;
}

export const data = new SlashCommandBuilder()
  .setName('admin')
  .setDescription('Bot administration')
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
  .addSubcommand((sub) => sub.setName('status').setDescription('Show the last check run'))
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

export function formatSummary(summary: RunSummary): string {
  const lines = Object.entries(summary.shops).map(([shop, s]) => {
    let line = `${shop}: ${s.listings} listings`;
    if (s.error) line += ` — error: ${s.error}`;
    if (s.skippedNoId) line += ` (skipped ${s.skippedNoId} without card number)`;
    return line;
  });
  lines.push(`Notified: ${summary.notified} · DM failures: ${summary.dmFailures}`);
  return lines.join('\n').slice(0, DISCORD_MESSAGE_LIMIT);
}

function statusText(): string {
  const last = runManager.last();
  if (!last) return 'No check has run yet.';
  const text = `Last run: <t:${Math.floor(last.finishedAt / 1000)}:R>\n${formatSummary(last)}`;
  return text.slice(0, DISCORD_MESSAGE_LIMIT);
}

function mapCards(url: string, cardsInput: string): string {
  const { ids, invalid } = parseCardList(cardsInput);
  if (ids.length === 0 && invalid.length === 0) return 'No card numbers found. Example: 12, LE8';
  const known = catalogManager.knownIds();
  const unknown = [...invalid, ...ids.filter((id) => !known.has(id))];
  if (unknown.length > 0) {
    return joinWithinLimit('Nothing changed. Unknown or invalid: ', [...new Set(unknown)]);
  }
  const listing = listingManager.overrideCards(url, ids, Date.now());
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
        const result = await ctx.trigger();
        await interaction.editReply({
          content: result === 'busy' ? 'A check is already running.' : formatSummary(result),
        });
        return;
      }
      default:
        throw new Error(`Unknown /admin subcommand: ${sub}`);
    }
  } catch (error) {
    logger.error(`[ADMIN COMMAND] Error: ${errorMessage(error)}`);
    await replyWithError(interaction, 'Error', 'Something went wrong running the admin command.');
  }
}
