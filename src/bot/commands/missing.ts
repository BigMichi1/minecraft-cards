import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { formatCardList } from '../cards/cardId';
import { catalogManager } from '../database/catalogManager';
import { listingManager } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { userManager, type ListChange } from '../database/userManager';
import { SHOP_IDS, type ShopId } from '../shops/types';
import type { CardId } from '../cards/cardId';
import { buildStatusReply, needsLastSuccess, type StatusReply } from './missingStatus';
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
      .setDescription('Your missing cards with what each shop last showed, and how fresh that is')
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

/** What `/missing` needs from the bot's wiring. */
export interface MissingContext {
  /** The shops this process checks (one per adapter built in bot.ts). */
  enabledShops: readonly ShopId[];
}

/** Gather what `/missing status` shows (all reads) and format it. */
function status(userId: string, now: number, ctx: MissingContext): StatusReply {
  const cards = userManager.getList(userId);
  const latest = runManager.latestReadable();
  // Only enabled shops whose latest check failed or did not run need their last success; before
  // the first readable run nothing is shown per shop, so nothing is looked up. null records
  // "looked up, none in the window", so the formatter can tell it from "not looked up".
  const lastSuccess: Partial<Record<ShopId, number | null>> = {};
  for (const shop of SHOP_IDS) {
    if (needsLastSuccess(latest.summary, shop, ctx.enabledShops)) {
      lastSuccess[shop] = runManager.lastSuccess(shop, now) ?? null;
    }
  }
  const names = new Map<CardId, string>();
  for (const card of cards) {
    const name = catalogManager.getCard(card)?.name;
    if (name) names.set(card, name);
  }
  return buildStatusReply({
    cards,
    latest,
    enabledShops: ctx.enabledShops,
    lastSuccess,
    listings: listingManager.listingsForCards(cards),
    names,
    now,
  });
}

/** The reply of `/missing <sub>`: text, plus the link embed for `status`. */
function run(
  interaction: ChatInputCommandInteraction,
  sub: string,
  ctx: MissingContext
): StatusReply {
  if (sub === 'status') return status(interaction.user.id, Date.now(), ctx);
  return { content: runListChange(interaction, sub), embeds: [] };
}

function runListChange(interaction: ChatInputCommandInteraction, sub: string): string {
  const userId = interaction.user.id;
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
    default:
      throw new Error(`Unknown /missing subcommand: ${sub}`);
  }
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: MissingContext
): Promise<void> {
  let sub: string | undefined;
  try {
    sub = interaction.options.getSubcommand();
    const { content, embeds } = run(interaction, sub, ctx);
    await interaction.reply({ content, embeds, flags: MessageFlags.Ephemeral });
  } catch (error) {
    logError(`[MISSING COMMAND] /missing ${sub ?? '(no subcommand)'} failed`, error);
    await replyWithError(
      interaction,
      'Error',
      sub === 'status'
        ? 'Could not load your stock status. Please try again later.'
        : 'Something went wrong while updating your list.'
    );
  }
}
