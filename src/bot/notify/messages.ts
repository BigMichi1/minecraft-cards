import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageCreateOptions,
} from 'discord.js';
import type { CardId } from '../cards/cardId';
import { encodeRightId } from '../interactions/buttonIds';
import type { CollectionId } from '../collections/ids';
import { catalogManager } from '../database/catalogManager';
import type { StoredListing } from '../database/listingManager';
import type { Money, ShopId } from '../shops/types';

export interface NotificationItem {
  listing: StoredListing;
  cardIds: readonly CardId[];
}

export const ITEMS_PER_MESSAGE = 5;
/**
 * Up to this many items (for one user in one run) each get their own message, so every
 * listing has its buttons right under it. More items are batched ITEMS_PER_MESSAGE per message.
 */
export const SINGLE_MESSAGE_LIMIT = 5;
const MAX_TITLE = 256;
const MAX_FIELD = 1024;
const MAX_LABEL = 80;
/**
 * Discord shows all button rows below all embeds, so in a batched message each embed title and
 * its row carry the same position marker (one per item of a message).
 */
const POSITION_MARKERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'] as const;

export const SHOP_NAMES: Record<ShopId, string> = {
  'sammel-ente': 'sammel-ente',
  'blue-ocean': 'blue-ocean',
  'collect-it': 'collect-it',
  ebay: 'eBay',
};

export function kleinanzeigenSearchUrl(cardId: CardId): string {
  return `https://www.kleinanzeigen.de/s-lego-minecraft-karte-${cardId.toLowerCase()}/k0`;
}

export const MAX_URL = 512;

/** Discord rejects non-http(s) and over-long URLs; a bad one must never break a whole batch. */
export function validUrl(url: string | null | undefined): string | null {
  if (!url || url.length > MAX_URL) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function formatPrice(price: Money): string {
  const amount = (price.cents / 100).toFixed(2);
  if (price.currency === 'EUR') return `${amount.replace('.', ',')} €`;
  return `${amount} ${price.currency}`;
}

function title(item: NotificationItem, marker: string): string {
  const { listing, cardIds } = item;
  const prefix = marker ? `${marker} ` : '';
  if (cardIds.length > 1) {
    const ids = cardIds.map((id) => `#${id}`).join(', ');
    return truncate(`${prefix}🟢 Bundle with ${ids} on ${SHOP_NAMES[listing.shop]}`, MAX_TITLE);
  }
  const [id] = cardIds;
  const name = id === undefined ? undefined : catalogManager.getCard(listing.collection, id)?.name;
  return truncate(
    `${prefix}🟢 Card #${id ?? '?'}${name ? ` ${name}` : ''} is available`,
    MAX_TITLE
  );
}

function footer(listing: StoredListing): string | null {
  switch (listing.matchStatus) {
    case 'confirmed':
      // `/admin map` confirms without a picture comparison.
      if (listing.similarity === null) return '✅ checked by the admin';
      if (listing.idSource === 'picture') {
        return `🖼️ number from the picture (${listing.similarity.toFixed(2)}) — compare with the reference`;
      }
      return `✅ picture matches reference (${listing.similarity.toFixed(2)})`;
    case 'unconfirmed':
      return '⚠️ number unconfirmed — compare with the reference';
    case 'bundle':
      return 'ℹ️ bundle — check the listing';
    case 'no_reference':
      return 'ℹ️ no reference picture yet';
    case 'pending':
      return 'ℹ️ picture not checked yet';
    case 'model_unavailable':
      return 'ℹ️ picture check unavailable';
    case 'image_unavailable':
      return 'ℹ️ picture could not be loaded';
    case 'mismatch':
      // Never sent to users (pendingNotifications); kept for an exhaustive switch.
      return `⚠️ the picture shows #${listing.pictureCardId ?? '?'}, not #${listing.cardIds[0] ?? '?'}`;
  }
}

/** The reference picture goes beside a number the picture alone gave, or one it did not back. */
function showsReference(listing: StoredListing): boolean {
  if (listing.matchStatus === 'unconfirmed') return true;
  return (
    listing.matchStatus === 'confirmed' &&
    listing.idSource === 'picture' &&
    !listing.manualOverride &&
    listing.similarity !== null
  );
}

/** Card id -> usable reference picture (no placeholder, none shared), read once per batch. */
type References = ReadonlyMap<CardId, string>;

function buildEmbed(item: NotificationItem, marker: string, references: References): EmbedBuilder {
  const { listing } = item;
  const priceParts: string[] = [];
  if (listing.price) priceParts.push(formatPrice(listing.price));
  if (listing.format === 'auction' && listing.auctionEndsAt !== null) {
    priceParts.push(`Auction · ends <t:${Math.floor(listing.auctionEndsAt / 1000)}:R>`);
  }
  if (listing.format === 'fixed_price') priceParts.push('Buy It Now');
  const embed = new EmbedBuilder().setTitle(title(item, marker)).addFields(
    { name: 'Shop', value: truncate(SHOP_NAMES[listing.shop], MAX_FIELD), inline: true },
    {
      name: 'Price',
      value: truncate(priceParts.length > 0 ? priceParts.join(' · ') : 'unknown', MAX_FIELD),
      inline: true,
    }
  );
  const listingUrl = validUrl(listing.url);
  if (listingUrl) embed.setURL(listingUrl);
  const imageUrl = validUrl(listing.imageUrl);
  if (imageUrl) embed.setImage(imageUrl);
  const text = footer(listing);
  if (text) embed.setFooter({ text });
  if (showsReference(listing)) {
    const thumbnail = validUrl(item.cardIds[0] ? references.get(item.cardIds[0]) : null);
    if (thumbnail) embed.setThumbnail(thumbnail);
  }
  return embed;
}

/**
 * Link to the listing (`#12 · sammel-ente`, `Bundle · eBay`), Kleinanzeigen search for the
 * (first) card, report button, and on an unconfirmed single card a Right button. The first
 * button carries the item's position marker.
 */
function buildRow(item: NotificationItem, marker: string): ActionRowBuilder<ButtonBuilder> {
  const { listing, cardIds } = item;
  const [first] = cardIds;
  const bundle = cardIds.length > 1;
  const shop = SHOP_NAMES[listing.shop];
  const buttons: { label: string; build: (label: string) => ButtonBuilder }[] = [];
  const listingUrl = validUrl(listing.url);
  if (listingUrl) {
    buttons.push({
      label: bundle ? `Bundle · ${shop}` : `#${first ?? '?'} · ${shop}`,
      build: (label) =>
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(listingUrl),
    });
  }
  if (first) {
    buttons.push({
      label: `Kleinanzeigen #${first}`,
      build: (label) =>
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel(label)
          .setURL(kleinanzeigenSearchUrl(first)),
    });
  }
  buttons.push({
    label: bundle ? '❌ Wrong bundle' : `❌ Wrong #${first ?? '?'}`,
    build: (label) =>
      new ButtonBuilder()
        .setStyle(ButtonStyle.Secondary)
        .setLabel(label)
        .setCustomId(`report:${listing.id}`),
  });
  // A user can vouch for an unconfirmed number; the admin then confirms it with one click.
  if (first && !bundle && listing.matchStatus === 'unconfirmed') {
    buttons.push({
      label: `✅ Right #${first}`,
      build: (label) =>
        new ButtonBuilder()
          .setStyle(ButtonStyle.Success)
          .setLabel(label)
          .setCustomId(encodeRightId(listing.id)),
    });
  }
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    buttons.map((b, i) =>
      b.build(truncate(i === 0 && marker ? `${marker} ${b.label}` : b.label, MAX_LABEL))
    )
  );
}

export interface NotificationMessage<T extends NotificationItem = NotificationItem> {
  message: MessageCreateOptions;
  /** Exactly the items shown in `message`. */
  items: T[];
}

/**
 * Up to SINGLE_MESSAGE_LIMIT items: one message per item, its embed and button row, no
 * position marker. More: one message per 5 items (Discord allows 10 embeds and 5 action rows
 * per message), embed n and button row n starting with the same position marker.
 */
export function buildNotificationMessages<T extends NotificationItem>(
  items: T[]
): NotificationMessage<T>[] {
  const messages: NotificationMessage<T>[] = [];
  // Each collection's references are read once per call, for its own listings only.
  const byCollection = new Map<CollectionId, References>();
  const referencesOf = (collection: CollectionId): References => {
    let references = byCollection.get(collection);
    if (!references) {
      references = new Map(
        catalogManager
          .referenceCatalog(collection)
          .usable.map((c) => [c.cardId, c.referenceImageUrl])
      );
      byCollection.set(collection, references);
    }
    return references;
  };
  const single = items.length <= SINGLE_MESSAGE_LIMIT;
  const perMessage = single ? 1 : ITEMS_PER_MESSAGE;
  const marker = (n: number) => (single ? '' : (POSITION_MARKERS[n] ?? `${n + 1}.`));
  for (let i = 0; i < items.length; i += perMessage) {
    const chunk = items.slice(i, i + perMessage);
    messages.push({
      message: {
        embeds: chunk.map((item, n) =>
          buildEmbed(item, marker(n), referencesOf(item.listing.collection))
        ),
        components: chunk.map((item, n) => buildRow(item, marker(n))),
      },
      items: chunk,
    });
  }
  return messages;
}
