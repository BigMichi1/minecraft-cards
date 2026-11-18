import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { formatCardList } from '../cards/cardId';
import { catalogManager } from '../database/catalogManager';
import { listingManager } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { userManager, type ListChange } from '../database/userManager';
import { SHOP_IDS, type ShopId } from '../shops/types';
import type { CardId } from '../cards/cardId';
import { buildStatusReply } from './missingStatus';
import { joinWithinLimit } from '../utils/messageLimit';
import { replyWithError } from '../utils/interactionReply';
import { logError } from '../utils/logger';

const LIST_OPTION_MAX_LENGTH = 6000;

export const data = new SlashCommandBuilder()
  .setName('missing')
  .setDescription('Manage the list of cards you are missing')
  .addSubcommand((sub) =>
    sub
      .setName('set')
      .setDescription('Replace your missing list')
      .addStringOption((o) =>
        o
          .setName('list')
          .setDescription('Card numbers, e.g. 12, 45, LE8 or 20-25')
          .setRequired(true)
          .setMaxLength(LIST_OPTION_MAX_LENGTH)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add cards to your missing list')
      .addStringOption((o) =>
        o
          .setName('list')
          .setDescription('Card numbers, e.g. 12, 45, LE8 or 20-25')
          .setRequired(true)
          .setMaxLength(LIST_OPTION_MAX_LENGTH)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove cards from your missing list')
      .addStringOption((o) =>
        o
          .setName('list')
          .setDescription('Card numbers, e.g. 12, 45, LE8 or 20-25')
          .setRequired(true)
          .setMaxLength(LIST_OPTION_MAX_LENGTH)
      )
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('Show your missing list'))
  .addSubcommand((sub) => sub.setName('clear').setDescription('Empty your missing list'))
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Your missing cards with what each shop showed at the last check')
  );

function describeChange(change: ListChange): string {
  if (change.ok) {
    return joinWithinLimit(
      `Your missing cards (${change.ids.length}): `,
      formatCardList(change.ids).split(', ')
    );
  }
  if (change.reason === 'empty') return 'No card numbers found. Example: 12, 45, LE8';
  return joinWithinLimit('Nothing changed. Unknown or invalid: ', [...new Set(change.invalid)]);
}

/** Gather what `/missing status` shows (all reads) and format it. */
function status(userId: string, now: number): string {
  const cards = userManager.getList(userId);
  const last = runManager.last();
  // Only shops whose latest check failed or did not run need their last success looked up.
  const lastSuccess: Partial<Record<ShopId, number>> = {};
  for (const shop of SHOP_IDS) {
    const entry = last?.shops[shop];
    if (!last || (entry !== undefined && entry.error === undefined)) continue;
    const at = runManager.lastSuccess(shop, now);
    if (at !== undefined) lastSuccess[shop] = at;
  }
  const names = new Map<CardId, string>();
  for (const card of cards) {
    const name = catalogManager.getCard(card)?.name;
    if (name) names.set(card, name);
  }
  return buildStatusReply({
    cards,
    last,
    lastSuccess,
    listings: listingManager.listingsForCards(cards),
    names,
    now,
  });
}

function run(interaction: ChatInputCommandInteraction): string {
  const userId = interaction.user.id;
  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'set':
      return describeChange(
        userManager.setList(userId, interaction.options.getString('list', true))
      );
    case 'add':
      return describeChange(
        userManager.addToList(userId, interaction.options.getString('list', true))
      );
    case 'remove':
      return describeChange(
        userManager.removeFromList(userId, interaction.options.getString('list', true))
      );
    case 'list': {
      const ids = userManager.getList(userId);
      return ids.length === 0
        ? 'You have no missing cards on your list.'
        : describeChange({ ok: true, ids });
    }
    case 'clear':
      userManager.clearList(userId);
      return 'Your missing list is now empty.';
    case 'status':
      return status(userId, Date.now());
    default:
      throw new Error(`Unknown /missing subcommand: ${sub}`);
  }
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  try {
    const content = run(interaction);
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch (error) {
    logError('[MISSING COMMAND] failed', error);
    await replyWithError(interaction, 'Error', 'Something went wrong while updating your list.');
  }
}
