import { compareCardIds, normalizeCardId } from '../cards/cardId';
import type { CardId } from '../cards/cardId';
import { REQUEST_TIMEOUT_MS, USER_AGENT, HttpError } from '../utils/http';
import type { FetchFn, Listing, Money, ShopAdapter } from './types';

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const TOKEN_SAFETY_MARGIN_MS = 60_000;

export const EBAY_QUERIES = [
  'lego minecraft on fire karte',
  'lego minecraft tcc serie 3',
  'lego minecraft trading card on fire',
];

const LE_XXL_PATTERN = /\b(LE|XXL)\s?(\d+)\b/gi;
// "12/228": only the series size counts, so dates (`11/2026`) and sizes (`10/12`) do not match.
const FRACTION_PATTERN = /\b(\d+)\s*\/\s*228\b/g;
const NOT_FOLLOWED_BY_WORD = '(?![\\dA-Za-zÄÖÜäöüß])';
// A list item after the first must be a whole id, not a price or count ("3er Set", "3 weitere", "5 €").
const LIST_ITEM = `#?\\d+${NOT_FOLLOWED_BY_WORD}(?!\\s*(?:€|EUR\\b|Stück|weitere|x\\b))`;
// A prefix followed by a list: "#12, #45 und 107", "Nr. 12, 45", "Karte 12". A decimal comma
// ("1,50") has no space after it, so it never continues a list.
const PREFIXED_LIST_PATTERN = new RegExp(
  `(?:#|\\b(?:Nr|No)\\.?|\\b(?:Karte|Card))\\s*(\\d+${NOT_FOLLOWED_BY_WORD}(?:(?:,\\s+|\\s*&\\s*|\\s+(?:und|and)\\s+)${LIST_ITEM})*)`,
  'gi'
);

/** Card ids named in an eBay title. Only prefixed forms count; bare numbers (`Serie 3`, `2026`) never do. */
export function extractCardIdsFromTitle(title: string): CardId[] {
  const ids = new Set<CardId>();
  const add = (raw: string) => {
    const id = normalizeCardId(raw);
    if (id) ids.add(id);
  };
  for (const m of title.matchAll(LE_XXL_PATTERN)) add(`${m[1]}${m[2]}`);
  for (const m of title.matchAll(FRACTION_PATTERN)) add(m[1] ?? '');
  for (const m of title.matchAll(PREFIXED_LIST_PATTERN)) {
    for (const num of (m[1] ?? '').match(/\d+/g) ?? []) add(num);
  }
  return [...ids].sort(compareCardIds);
}

interface EbayMoney {
  value?: string;
  currency?: string;
}

interface EbayItem {
  itemId?: string;
  title?: string;
  itemWebUrl?: string;
  image?: { imageUrl?: string };
  price?: EbayMoney;
  currentBidPrice?: EbayMoney;
  buyingOptions?: string[];
  shippingOptions?: { shippingCost?: EbayMoney }[];
  itemEndDate?: string;
}

/** "1.49" -> 149 without float arithmetic. */
function toCents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?\d*$/.exec(value.trim());
  if (!match) return null;
  return (
    Number.parseInt(match[1] ?? '0', 10) * 100 +
    Number.parseInt((match[2] ?? '').padEnd(2, '0') || '0', 10)
  );
}

function parseMoney(money: EbayMoney | undefined): Money | null {
  if (!money?.value || !money.currency) return null;
  const cents = toCents(money.value);
  return cents === null ? null : { cents, currency: money.currency };
}

function totalPrice(item: EbayItem, isAuction: boolean): Money | null {
  const base = parseMoney(isAuction ? (item.currentBidPrice ?? item.price) : item.price);
  if (!base) return null;
  const shipping = parseMoney(item.shippingOptions?.[0]?.shippingCost);
  if (shipping && shipping.currency === base.currency) {
    return { cents: base.cents + shipping.cents, currency: base.currency };
  }
  return base;
}

function toListing(item: EbayItem): Listing | null {
  if (!item.itemWebUrl || !item.title) return null;
  const isAuction = item.buyingOptions?.includes('AUCTION') ?? false;
  const endsAt = isAuction && item.itemEndDate ? Date.parse(item.itemEndDate) : Number.NaN;
  return {
    shop: 'ebay',
    url: item.itemWebUrl,
    title: item.title,
    cardIds: extractCardIdsFromTitle(item.title),
    cardName: null,
    imageUrl: item.image?.imageUrl ?? null,
    price: totalPrice(item, isAuction),
    available: true,
    format: isAuction ? 'auction' : 'fixed_price',
    auctionEndsAt: Number.isNaN(endsAt) ? null : endsAt,
    idConflict: false,
  };
}

export function createEbayAdapter(opts: {
  clientId: string;
  clientSecret: string;
  fetchFn?: FetchFn;
}): ShopAdapter & { lastSkippedNoId: number } {
  const fetchFn = opts.fetchFn ?? fetch;
  let token: { value: string; expiresAt: number } | null = null;

  async function getToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value;
    const response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${opts.clientId}:${opts.clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT,
      },
      body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new HttpError(response.status, TOKEN_URL);
    const body = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token || typeof body.expires_in !== 'number') {
      throw new Error('eBay token response has no access_token/expires_in');
    }
    token = {
      value: body.access_token,
      expiresAt: Date.now() + body.expires_in * 1000 - TOKEN_SAFETY_MARGIN_MS,
    };
    return token.value;
  }

  async function search(query: string): Promise<EbayItem[]> {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=200`;
    const response = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new HttpError(response.status, url);
    const body = (await response.json()) as { itemSummaries?: EbayItem[] };
    return body.itemSummaries ?? [];
  }

  const adapter: ShopAdapter & { lastSkippedNoId: number } = {
    id: 'ebay',
    lastSkippedNoId: 0,
    async fetchListings() {
      const byItemId = new Map<string, Listing>();
      const skipped = new Set<string>();
      for (const query of EBAY_QUERIES) {
        for (const item of await search(query)) {
          const itemId = item.itemId ?? item.itemWebUrl ?? '';
          if (byItemId.has(itemId) || skipped.has(itemId)) continue;
          const listing = toListing(item);
          if (!listing) continue;
          if (listing.cardIds.length === 0) skipped.add(itemId);
          else byItemId.set(itemId, listing);
        }
      }
      adapter.lastSkippedNoId = skipped.size;
      return [...byItemId.values()];
    },
  };
  return adapter;
}
