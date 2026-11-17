import { compareCardIds, normalizeCardId } from '../cards/cardId';
import type { CardId } from '../cards/cardId';
import { errorMessage } from '../utils/async';
import { REQUEST_TIMEOUT_MS, USER_AGENT, HttpError } from '../utils/http';
import logger from '../utils/logger';
import {
  ShopLayoutError,
  type FetchFn,
  type FetchResult,
  type Listing,
  type Money,
  type ShopAdapter,
} from './types';

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const ITEM_URL = 'https://www.ebay.de/itm/';
const TOKEN_SAFETY_MARGIN_MS = 60_000;
const SEARCH_LIMIT = 200;

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

/**
 * Card ids named in an eBay title. Only prefixed forms (`#12`, `Nr. 12`, `Karte 12`, `LE8`) and
 * `n/228` count; bare numbers (`Serie 3`, `2026`) never do.
 */
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
  legacyItemId?: string;
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

/**
 * The stable listing URL. `itemWebUrl` carries per-search tracking (`?hash=…&amdata=…`), so the
 * same item would get a new URL, a new row and a new notification on every search. The URL is
 * built from `legacyItemId`, else from the middle of `itemId` (`v1|<n>|<variation>`), else it is
 * `itemWebUrl` without its query string.
 */
function listingUrl(item: EbayItem): string | null {
  const legacy = item.legacyItemId ?? /^v1\|(\d+)\|/.exec(item.itemId ?? '')?.[1];
  if (legacy && /^\d+$/.test(legacy)) return `${ITEM_URL}${legacy}`;
  if (!item.itemWebUrl) return null;
  try {
    const url = new URL(item.itemWebUrl);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function toListing(item: EbayItem): Listing | null {
  const url = listingUrl(item);
  if (!url || !item.title) return null;
  const isAuction = item.buyingOptions?.includes('AUCTION') ?? false;
  const endsAt = isAuction && item.itemEndDate ? Date.parse(item.itemEndDate) : Number.NaN;
  return {
    shop: 'ebay',
    url,
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

interface SearchResponse {
  itemSummaries?: EbayItem[];
  total?: number;
  errors?: { message?: string; longMessage?: string }[];
}

export function createEbayAdapter(opts: {
  clientId: string;
  clientSecret: string;
  fetchFn?: FetchFn;
}): ShopAdapter {
  const fetchFn = opts.fetchFn ?? fetch;
  let token: { value: string; expiresAt: number } | null = null;

  /** An error body without the client secret or access token in it. */
  function redact(text: string): string {
    let out = text.split(opts.clientSecret).join('[redacted]');
    if (token) out = out.split(token.value).join('[redacted]');
    return out;
  }

  /**
   * HttpError for a failed answer, with eBay's own error text: the `error`/`error_description`
   * of an OAuth answer or the messages of an API `errors` list, never other fields (a token
   * answer carries the access token). A body that is not JSON is kept as text.
   */
  async function failure(response: Response, url: string): Promise<HttpError> {
    const text = await response.text().catch(() => '');
    let detail = text;
    try {
      const json = JSON.parse(text) as {
        error?: string;
        error_description?: string;
        errors?: { message?: string; longMessage?: string }[];
      };
      detail = [
        json.error,
        json.error_description,
        ...(json.errors ?? []).map((e) => e.longMessage ?? e.message),
      ]
        .filter((part): part is string => typeof part === 'string')
        .join('; ');
    } catch {
      // Not JSON: an HTML error page or plain text.
    }
    return new HttpError(response.status, url, redact(detail));
  }

  async function readJson<T>(response: Response, url: string): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new Error(`eBay answer from ${url} is not JSON: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

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
    if (!response.ok) throw await failure(response, TOKEN_URL);
    const body = await readJson<{ access_token?: string; expires_in?: number }>(
      response,
      TOKEN_URL
    );
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
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}`;
    const response = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${await getToken()}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw await failure(response, url);
    const body = await readJson<SearchResponse>(response, url);
    if (!body.itemSummaries) {
      const errors = (body.errors ?? []).map((e) => e.longMessage ?? e.message ?? '?');
      if (errors.length > 0) {
        throw new Error(
          `eBay search "${query}" failed: ${redact(errors.join('; ')).slice(0, 300)}`
        );
      }
      return [];
    }
    if (typeof body.total === 'number' && body.total > body.itemSummaries.length) {
      // Only the first page is read; a search this broad needs a narrower query.
      logger.warn(
        `eBay search "${query}": ${body.total} results, only the first ${body.itemSummaries.length} read`
      );
    }
    return body.itemSummaries;
  }

  return {
    id: 'ebay',
    async fetchListings(): Promise<FetchResult> {
      const byUrl = new Map<string, Listing>();
      const skipped = new Set<string>();
      let skippedInvalid = 0;
      let itemsSeen = 0;
      for (const query of EBAY_QUERIES) {
        const items = await search(query);
        itemsSeen += items.length;
        for (const item of items) {
          const listing = toListing(item);
          if (!listing) {
            skippedInvalid++;
            continue;
          }
          if (byUrl.has(listing.url) || skipped.has(listing.url)) continue;
          if (listing.cardIds.length === 0) skipped.add(listing.url);
          else byUrl.set(listing.url, listing);
        }
      }
      // Same rule as the shops: an answer with nothing in it is an API or query problem,
      // and must not mark every stored eBay listing unavailable.
      if (itemsSeen === 0) {
        throw new ShopLayoutError(`eBay: all ${EBAY_QUERIES.length} searches returned no items`);
      }
      return { listings: [...byUrl.values()], skippedNoId: skipped.size, skippedInvalid };
    },
  };
}
