import { compareCardIds, normalizeCardId } from '../cards/cardId';
import type { CardId } from '../cards/cardId';
import { errorMessage, sleep as realSleep } from '../utils/async';
import { REQUEST_TIMEOUT_MS, USER_AGENT, HttpError } from '../utils/http';
import logger from '../utils/logger';
import {
  ShopLayoutError,
  type AdapterOptions,
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
/** Items per search page, the Browse API maximum. */
const SEARCH_LIMIT = 200;
/** Pages read per query: 1000 results. The broadest query had 295 on 2026-11-18. */
const MAX_PAGES_PER_QUERY = 5;
const PAGE_DELAY_MS = 1500;

export const EBAY_QUERIES = [
  'lego minecraft on fire karte',
  'lego minecraft tcc serie 3',
  'lego minecraft trading card on fire',
  // Most single cards ("LEGO Minecraft Karten 30 - Steve - Charakterkarte Serie 3 (2026)").
  'lego minecraft karten serie 3',
];

const LETTER = 'A-Za-zÄÖÜäöüß';
// "Serie 3", "Series 3", "Serie3", "On Fire".
const SERIES_3_PATTERN = /\bSeries?\s*3\b|\bOn\s*Fire\b/i;
// "Serie 1", "Series 2", but not "Serie 12".
const SERIES_1_2_PATTERN = /\bSeries?\s*[12]\b/i;
// A listing the buyer picks a card from: "zum aussuchen", "auswählen", "Auswahl", "du wählst".
const MULTI_PICK_PATTERN = /aussuch|auswahl|w(?:ä|ae)hl|\bchoos|\bpick\b/i;
// A number range: "1 - 228", "151-254", "LE1 - LE22", "1 bis 228".
const RANGE_PATTERN = /\b(?:LE|XXL)?\d+\s*(?:-|–|bis\b)\s*(?:LE|XXL)?\d+\b/i;

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

// "Karten 30 - Steve - …": the number after "Karten" and before a spaced dash.
const KARTEN_DASH_PATTERN = /\bKarten\s+(\d{1,3})\s+[-–]\s/gi;
// "Minecraft  132 - Wither Skeleton - Charakterkarte": number, name, card type ending in "karte".
const NUMBER_NAME_TYPE_PATTERN = new RegExp(
  `(?:^|\\s)(\\d{1,3})\\s+[-–]\\s+[^-–]+?\\s+[-–]\\s+[${LETTER}]*karte(?![${LETTER}])`,
  'gi'
);
// "ZOMBIE 68 Karte", "VILLAGER 8 Card": a name, a number, then the singular "Karte" or "Card".
// The plural ("6 Karten", "6 Cards") is a count.
const NAME_NUMBER_CARD_PATTERN = new RegExp(
  `(?<![${LETTER}\\d])([${LETTER}]+)\\s+(\\d{1,3})\\s+(?:Karte|Card)(?![${LETTER}])`,
  'gi'
);
// Words before a number that make it a series number or a count, not a card number.
const NOT_A_NAME = new Set([
  'serie',
  'series',
  'staffel',
  'season',
  'inkl',
  'incl',
  'inklusive',
  'including',
  'plus',
  'mit',
  'with',
  'und',
  'and',
  'je',
  'nur',
  'ab',
  'x',
  'ca',
  'über',
  'set',
  'lot',
]);

/**
 * True when a title can name a series 3 card: it names series 3 ("Serie 3", "On Fire"), names
 * no other series (a lot mixing series 1 or 2 is ambiguous), and is not a listing to pick
 * cards from or a number range ("Einzelkarten 1 - 228 zum aussuchen"): a range is not stock.
 */
function isSeries3Offer(title: string): boolean {
  return (
    SERIES_3_PATTERN.test(title) &&
    !SERIES_1_2_PATTERN.test(title) &&
    !MULTI_PICK_PATTERN.test(title) &&
    !RANGE_PATTERN.test(title)
  );
}

/**
 * Card ids named in an eBay title, only for a title that offers series 3 cards (see
 * isSeries3Offer). Prefixed forms (`#12`, `Nr. 12`, `Karte 12`, `LE8`), `n/228`,
 * `Karten 30 - Name`, `132 - Name - Charakterkarte` and `ZOMBIE 68 Karte` count; bare numbers
 * (`Serie 3`, `2026`) and counts (`6 Karten`) never do.
 */
export function extractCardIdsFromTitle(title: string): CardId[] {
  if (!isSeries3Offer(title)) return [];
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
  for (const m of title.matchAll(KARTEN_DASH_PATTERN)) add(m[1] ?? '');
  for (const m of title.matchAll(NUMBER_NAME_TYPE_PATTERN)) add(m[1] ?? '');
  for (const m of title.matchAll(NAME_NUMBER_CARD_PATTERN)) {
    if (!NOT_A_NAME.has((m[1] ?? '').toLowerCase())) add(m[2] ?? '');
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
  itemGroupType?: string;
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
    // A listing with variations (`SELLER_DEFINED_VARIATIONS`) sells a choice of cards under one
    // title; which of them is in stock is not in the search answer.
    cardIds: item.itemGroupType ? [] : extractCardIdsFromTitle(item.title),
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

export function createEbayAdapter(
  opts: {
    clientId: string;
    clientSecret: string;
    fetchFn?: FetchFn;
  } & AdapterOptions
): ShopAdapter {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const delayMs = opts.delayMs ?? PAGE_DELAY_MS;
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
   * answer carries the access token); an answer with none of those gives its `message` or
   * `title`, else the names of its fields, never its values. A body that is not JSON is kept as
   * text; a JSON array or a JSON value that is not an object is named, not echoed.
   */
  async function failure(response: Response, url: string): Promise<HttpError> {
    const text = await response.text().catch(() => '');
    let detail = text;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: an HTML error page or plain text, kept as it is.
    }
    if (Array.isArray(json)) {
      detail = 'answer is a JSON array';
    } else if (typeof json === 'object' && json !== null) {
      const body = json as {
        error?: string;
        error_description?: string;
        message?: string;
        title?: string;
        errors?: { message?: string; longMessage?: string }[];
      };
      const parts = [
        body.error,
        body.error_description,
        ...(Array.isArray(body.errors) ? body.errors : []).map((e) =>
          [e?.longMessage, e?.message].find((part) => typeof part === 'string')
        ),
      ].filter((part): part is string => typeof part === 'string');
      if (parts.length === 0) {
        // A gateway or WAF answer: its message or title, else only the names of its fields.
        const note = [body.message, body.title].find((part) => typeof part === 'string');
        parts.push(note ?? `answer with fields: ${Object.keys(json).join(', ') || 'none'}`);
      }
      detail = parts.join('; ');
    } else if (json !== undefined) {
      detail = 'answer is JSON but not an object';
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

  /** One page of a search; `pace` waits before every request but the first of a run. */
  async function searchPage(
    query: string,
    offset: number,
    pace: () => Promise<void>
  ): Promise<{ items: EbayItem[]; total: number | null }> {
    const url = `${SEARCH_URL}?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}&offset=${offset}`;
    await pace();
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
    }
    return {
      items: body.itemSummaries ?? [],
      total: typeof body.total === 'number' ? body.total : null,
    };
  }

  /**
   * Every result of a search, page by page by `offset`, up to MAX_PAGES_PER_QUERY pages. The
   * walk ends at an empty page, at the answer's total, or (without a total) at a short page.
   */
  async function search(query: string, pace: () => Promise<void>): Promise<EbayItem[]> {
    const all: EbayItem[] = [];
    let total: number | null = null;
    for (let page = 0; page < MAX_PAGES_PER_QUERY; page++) {
      const result = await searchPage(query, all.length, pace);
      total = result.total ?? total;
      all.push(...result.items);
      if (result.items.length === 0) return all;
      if (total !== null ? all.length >= total : result.items.length < SEARCH_LIMIT) return all;
    }
    if (total === null || total > all.length) {
      logger.warn(
        `eBay search "${query}": ${total ?? 'more'} results, only the first ${all.length} read (${MAX_PAGES_PER_QUERY}-page cap)`
      );
    }
    return all;
  }

  return {
    id: 'ebay',
    async fetchListings(): Promise<FetchResult> {
      const byUrl = new Map<string, Listing>();
      const skipped = new Set<string>();
      let skippedInvalid = 0;
      let itemsSeen = 0;
      let requests = 0;
      // 1500 ms between two search requests, as between two pages of a shop.
      const pace = async () => {
        if (requests++ > 0) await sleep(delayMs);
      };
      for (const query of EBAY_QUERIES) {
        const items = await search(query, pace);
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
