import { MessageFlags, SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { normalizeCardId } from '../cards/cardId';
import { catalogManager } from '../database/catalogManager';
import { listingManager } from '../database/listingManager';
import { runManager } from '../database/runManager';
import { downloadImage } from '../matcher/embedder';
import { SHOP_NAMES } from '../notify/messages';
import { attachPictures, PictureRun, type DownloadFn } from '../notify/pictures';
import { SHOP_IDS, type ShopId } from '../shops/types';
import { replyWithError } from '../utils/interactionReply';
import { logError } from '../utils/logger';
import { clipText } from '../utils/messageLimit';
import { buildCardReply } from './cardReply';
import { collectionOption, readCollection, UNKNOWN_COLLECTION } from './collectionOption';

/** What `/card` needs from the bot's wiring. */
export interface CardContext {
  /** The shops this process checks (one per adapter built in bot.ts). */
  enabledShops: readonly ShopId[];
  /** Downloads the reference picture to attach; the bounded matcher download by default. */
  download?: DownloadFn;
}

/** `#XXL123` with room to spare; a card id is never longer. */
const NUMBER_MAX_LENGTH = 10;

export const data = new SlashCommandBuilder()
  .setName('card')
  .setDescription('One card in every shop, with links to the cheapest offers')
  .addStringOption(collectionOption)
  .addStringOption((o) =>
    o
      .setName('number')
      .setDescription('Card number, e.g. 12, LE8 or XXL1')
      .setRequired(true)
      .setMaxLength(NUMBER_MAX_LENGTH)
  )
  .addStringOption((o) =>
    o
      .setName('shop')
      .setDescription('Show this shop only')
      .addChoices(...SHOP_IDS.map((shop) => ({ name: SHOP_NAMES[shop], value: shop })))
  );

function isShopId(value: string): value is ShopId {
  return (SHOP_IDS as readonly string[]).includes(value);
}

/** A plain text answer that replaces the deferred reply. */
const text = (content: string) => ({ content, embeds: [], components: [] });

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: CardContext
): Promise<void> {
  const token = clipText(interaction.options.getString('number', true).trim(), NUMBER_MAX_LENGTH);
  try {
    // Downloading the reference picture can take longer than Discord's 3 s to answer.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const collection = readCollection(interaction);
    if (!collection) {
      await interaction.editReply(text(UNKNOWN_COLLECTION));
      return;
    }
    const id = normalizeCardId(token);
    const card = id ? catalogManager.getCard(collection, id) : undefined;
    if (!card) {
      await interaction.editReply(text(`Unknown card: ${token}`));
      return;
    }
    const shopOption = interaction.options.getString('shop');
    // Discord only sends a declared choice; a value that is no shop is refused all the same.
    if (shopOption !== null && !isShopId(shopOption)) {
      await interaction.editReply(text(`Unknown shop: ${clipText(shopOption, 20)}`));
      return;
    }
    if (shopOption !== null && !ctx.enabledShops.includes(shopOption)) {
      await interaction.editReply(text(`${SHOP_NAMES[shopOption]} is not enabled.`));
      return;
    }
    // Only a usable reference: never a placeholder, never one shared by several cards.
    const reference =
      catalogManager.referenceCatalog(collection).usable.find((r) => r.cardId === card.cardId)
        ?.referenceImageUrl ?? null;
    const reply = buildCardReply({
      card: card.cardId,
      name: card.name,
      reference,
      shop: shopOption,
      latest: runManager.latestReadable(),
      enabledShops: ctx.enabledShops,
      listings: listingManager.listingsForCards(collection, [card.cardId]),
      now: Date.now(),
    });
    const download: DownloadFn =
      ctx.download ?? ((url, maxBytes) => downloadImage(url, fetch, maxBytes));
    // attachPictures never rejects: a picture it cannot attach keeps its URL, as in the alerts.
    const message = await attachPictures(reply, new PictureRun(download));
    await interaction.editReply({
      embeds: message.embeds ?? [],
      components: reply.components,
      files: message.files ?? [],
    });
  } catch (error) {
    logError(`[CARD COMMAND] /card ${token} failed`, error);
    await replyWithError(interaction, 'Error', 'Could not load this card. Please try again later.');
  }
}
