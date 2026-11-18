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
import { needsLastSuccess } from './shopCell';
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
  enabledShops: readonly ShopId[];
}

export const data = new SlashCommandBuilder()
  .setName('stock')
  .setDescription('Every card and which shops have it in stock, page by page')
  .addStringOption((o) =>
    o
      .setName('only')
      .setDescription('Which cards to show (default: all)')
      .addChoices(...STOCK_FILTERS.map((f) => ({ name: f, value: f })))
  );

const LOAD_ERROR = 'Could not load the stock table. Please try again later.';

/** Gather one page (all reads, for the user `userId`) and format it. */
function page(userId: string, filter: StockFilter, pageNo: number, ctx: StockContext): StockPage {
  const now = Date.now();
  const cards =
    filter === 'missing'
      ? userManager.getList(userId)
      : [...catalogManager.knownIds()].sort(compareCardIds);
  const latest = runManager.latestReadable();
  const lastSuccess: Partial<Record<ShopId, number | null>> = {};
  for (const shop of SHOP_IDS) {
    if (needsLastSuccess(latest.summary, shop, ctx.enabledShops)) {
      lastSuccess[shop] = runManager.lastSuccess(shop, now) ?? null;
    }
  }
  return buildStockPage({
    cards,
    filter,
    page: pageNo,
    latest,
    enabledShops: ctx.enabledShops,
    lastSuccess,
    listings: listingManager.listingsForCards(cards),
    now,
  });
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: StockContext
): Promise<void> {
  try {
    // Discord only sends one of the declared choices; anything else falls back to all.
    const only = interaction.options.getString('only');
    const filter = STOCK_FILTERS.find((f) => f === only) ?? 'all';
    await interaction.reply({
      ...page(interaction.user.id, filter, 1, ctx),
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
        content: 'This button is not valid.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.update(page(interaction.user.id, parsed.filter, parsed.page, ctx));
  } catch (error) {
    logError(`[STOCK BUTTON] ${interaction.customId} failed`, error);
    await replyWithError(interaction, 'Error', LOAD_ERROR);
  }
}
