import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageCreateOptions,
} from 'discord.js';
import type { CardId } from '../cards/cardId';
import { catalogManager } from '../database/catalogManager';
import type { StoredListing } from '../database/listingManager';
import type { Money, ShopId } from '../shops/types';

export interface NotificationItem {
  listing: StoredListing;
  cardIds: CardId[];
}

const ITEMS_PER_MESSAGE = 5;
const MAX_TITLE = 256;
const MAX_FIELD = 1024;

const SHOP_NAMES: Record<ShopId, string> = {
  'sammel-ente': 'sammel-ente',
  'blue-ocean': 'blue-ocean',
  ebay: 'eBay',
};

export function kleinanzeigenSearchUrl(cardId: CardId): string {
  return `https://www.kleinanzeigen.de/s-lego-minecraft-karte-${cardId.toLowerCase()}/k0`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function formatPrice(price: Money): string {
  const amount = (price.cents / 100).toFixed(2);
  if (price.currency === 'EUR') return `${amount.replace('.', ',')} €`;
  return `${amount} ${price.currency}`;
}

function title(item: NotificationItem): string {
  const { listing, cardIds } = item;
  if (cardIds.length > 1) {
    const ids = cardIds.map((id) => `#${id}`).join(', ');
    return truncate(`🟢 Bundle with ${ids} on ${SHOP_NAMES[listing.shop]}`, MAX_TITLE);
  }
  const id = cardIds[0] ?? '?';
  const name = catalogManager.getCard(id)?.name;
  return truncate(`🟢 Card #${id}${name ? ` ${name}` : ''} is available`, MAX_TITLE);
}

function footer(listing: StoredListing): string | null {
  switch (listing.matchStatus) {
    case 'confirmed':
      return `✅ picture matches reference (${(listing.similarity ?? 0).toFixed(2)})`;
    case 'unconfirmed':
      return '⚠️ number unconfirmed — compare with the reference';
    case 'bundle':
      return 'ℹ️ bundle — check the listing';
    case 'no_reference':
      return 'ℹ️ no reference picture yet';
    case 'model_unavailable':
      return 'ℹ️ picture check unavailable';
    case 'reference':
      return null;
  }
}

function buildEmbed(item: NotificationItem): EmbedBuilder {
  const { listing } = item;
  const priceParts: string[] = [];
  if (listing.price) priceParts.push(formatPrice(listing.price));
  if (listing.format === 'auction' && listing.auctionEndsAt !== null) {
    priceParts.push(`Auction · ends <t:${Math.floor(listing.auctionEndsAt / 1000)}:R>`);
  }
  const embed = new EmbedBuilder()
    .setTitle(title(item))
    .setURL(listing.url)
    .addFields(
      { name: 'Shop', value: truncate(SHOP_NAMES[listing.shop], MAX_FIELD), inline: true },
      {
        name: 'Price',
        value: truncate(priceParts.length > 0 ? priceParts.join(' · ') : 'unknown', MAX_FIELD),
        inline: true,
      }
    );
  if (listing.imageUrl) embed.setImage(listing.imageUrl);
  const text = footer(listing);
  if (text) embed.setFooter({ text });
  if (listing.matchStatus === 'unconfirmed') {
    const reference = item.cardIds[0] ? catalogManager.getCard(item.cardIds[0]) : undefined;
    if (reference?.referenceImageUrl) embed.setThumbnail(reference.referenceImageUrl);
  }
  return embed;
}

function buildRow(item: NotificationItem): ActionRowBuilder<ButtonBuilder> {
  const buttons = [
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Open in shop')
      .setURL(item.listing.url),
  ];
  if (item.cardIds[0]) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Kleinanzeigen')
        .setURL(kleinanzeigenSearchUrl(item.cardIds[0]))
    );
  }
  buttons.push(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Secondary)
      .setLabel('❌ Wrong card')
      .setCustomId(`report:${item.listing.id}`)
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

/** One message per 5 items (Discord allows 10 embeds and 5 action rows per message). */
export function buildNotificationMessages(items: NotificationItem[]): MessageCreateOptions[] {
  const messages: MessageCreateOptions[] = [];
  for (let i = 0; i < items.length; i += ITEMS_PER_MESSAGE) {
    const chunk = items.slice(i, i + ITEMS_PER_MESSAGE);
    messages.push({ embeds: chunk.map(buildEmbed), components: chunk.map(buildRow) });
  }
  return messages;
}
