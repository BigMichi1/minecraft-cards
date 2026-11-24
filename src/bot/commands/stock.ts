import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { compareCardIds } from '../cards/cardId';
import { catalogManager } from '../database/catalogManager';
import { listingManager } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { userManager } from '../database/userManager';
import { SHOP_IDS, type ShopId } from '../shops/types';
import { replyWithError } from '../utils/interactionReply';
import logger, { logError } from '../utils/logger';
import type { CollectionId } from '../collections/ids';
import { collectionOption, readCollection, UNKNOWN_COLLECTION } from './collectionOption';
import { enabledFor, needsLastSuccess, type EnabledShops } from './shopCell';
import {
  buildStockPage,
  parseStockCustomId,
  STOCK_FILTERS,
  type StockFilter,
  type StockPage,
} from './stockPage';

/** What `/stock` needs from the bot's wiring. */
export interface StockContext {
  /** The shops this process checks (one per adapter built in bot.ts). */
  /** The shops checked per collection; any other shop is not enabled there. */
  enabledShops: EnabledShops;
}

export const data = new SlashCommandBuilder()
  .setName('stock')
  .setDescription('Every card and which shops have it in stock, page by page')
  .addStringOption(collectionOption)
  .addStringOption((o) =>
    o
      .setName('only')
      .setDescription('Which cards to show (default: all)')
      .addChoices(...STOCK_FILTERS.map((f) => ({ name: f, value: f })))
  );

const LOAD_ERROR = 'Could not load the stock table. Please try again later.';

/** Gather one page (all reads, for the user `userId`) and format it. */
function page(
  userId: string,
  collection: CollectionId,
  filter: StockFilter,
  pageNo: number,
  ctx: StockContext
): StockPage {
  const now = Date.now();
  const cards =
    filter === 'missing'
      ? userManager.getList(userId, collection)
      : [...catalogManager.knownIds(collection)].sort(compareCardIds);
  const latest = runManager.latestReadable();
  const enabled = enabledFor(ctx.enabledShops, collection);
  const lastSuccess: Partial<Record<ShopId, number | null>> = {};
  for (const shop of SHOP_IDS) {
    if (needsLastSuccess(latest.summary, collection, shop, enabled)) {
      lastSuccess[shop] = runManager.lastSuccess(shop, collection, now) ?? null;
    }
  }
  return buildStockPage({
    collection,
    cards,
    filter,
    page: pageNo,
    latest,
    enabledShops: enabled,
    lastSuccess,
    listings: listingManager.listingsForCards(collection, cards),
    now,
  });
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: StockContext
): Promise<void> {
  try {
    const collection = readCollection(interaction);
    if (!collection) {
      await interaction.reply({ content: UNKNOWN_COLLECTION, flags: MessageFlags.Ephemeral });
      return;
    }
    // Discord only sends one of the declared choices; anything else falls back to all.
    const only = interaction.options.getString('only');
    const filter = STOCK_FILTERS.find((f) => f === only) ?? 'all';
    await interaction.reply({
      ...page(interaction.user.id, collection, filter, 1, ctx),
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    logError('[STOCK COMMAND] /stock failed', error);
    await replyWithError(interaction, 'Error', LOAD_ERROR);
  }
}

/**
 * A ◀ ▶ click: re-read the data and replace the page in place. The custom id comes back from
 * Discord, so one this bot did not build is refused before anything is read.
 */
export async function handleStockButton(
  interaction: ButtonInteraction,
  ctx: StockContext
): Promise<void> {
  try {
    const parsed = parseStockCustomId(interaction.customId);
    if (!parsed) {
      logger.warn(`[STOCK BUTTON] invalid custom id ${JSON.stringify(interaction.customId)}`);
      await interaction.reply({
        content: 'This button is not valid or out of date; run /stock again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.update(
      page(interaction.user.id, parsed.collection, parsed.filter, parsed.page, ctx)
    );
  } catch (error) {
    logError(`[STOCK BUTTON] ${interaction.customId} failed`, error);
    await replyWithError(interaction, 'Error', LOAD_ERROR);
  }
}
