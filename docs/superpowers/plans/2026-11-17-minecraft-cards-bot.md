# Minecraft Cards Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Discord bot that checks shop-sammel-ente, blue-ocean and eBay hourly and DMs each user when a LEGO Minecraft "On Fire" card on their missing list becomes buyable, with a local image-similarity safety net and admin wrong-card reports.

**Architecture:** Bun + discord.js bot, tooling copied from `../IdleCodeRedeemer`. Shop adapters return a common `Listing[]`; a single-flight hourly runner stores listings in SQLite (Drizzle), runs the image check, diffs against stored state and sends batched DMs. Slash commands manage per-user lists; buttons/modals carry wrong-card reports to the admin.

**Tech Stack:** Bun 1.4.x, TypeScript (typecheck-only), discord.js 14, drizzle-orm + `bun:sqlite`, winston, cheerio (HTML parsing), `@huggingface/transformers` (local image embeddings), eBay Browse API.

**Spec:** `docs/superpowers/specs/2026-11-17-minecraft-cards-bot-design.md` (read it first; this plan argues from it).

## Global Constraints

- All tasks run through `./bin/mise run <task>`; never call `bun run`/`npm`/`npx` directly. A missing task gets added to `.mise.toml`.
- Copy tooling and structure from `/home/bigmichi1/projects/IdleCodeRedeemer`, not its Idle Champions code. Where this plan says "copy from ref", adapt names (`idle-code-redeemer` → `minecraft-cards`, `idle.db` → `cards.db`).
- Every non-test source file in `src/` has a matching `*.test.ts` next to it.
- Conventional Commits; scopes: `bot`, `cards`, `database`, `shops`, `ebay`, `matcher`, `notify`, `commands`, `admin`, `ci`, `docs`, `docker`. Every commit `git commit -s` and ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.
- Shell scripts and hooks must be POSIX `sh` (ref's `.husky/pre-push` uses bash arrays under `#!/bin/sh` — do not copy that bug).
- Commands are imported statically in `bot.ts` (dynamic scanning breaks the compiled bundle).
- Timestamps are stored as integer epoch milliseconds (avoids ref's UTC-without-zone `CURRENT_TIMESTAMP` parsing trap).
- Card ids are canonical strings: `"12"`, `"LE8"`, `"XXL1"` (no leading zeros, uppercase prefix).
- Never log secrets: `DISCORD_TOKEN`, `EBAY_CLIENT_SECRET`, eBay access tokens.
- HTTP requests to shops use User-Agent `minecraft-cards-bot/1.0 (+hourly stock check)`, 20 s timeout, 1500 ms delay between page requests of one shop.
- Env: `DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `BOT_ADMIN_ID`, `DB_PATH` (default `./data/cards.db`), `LOG_LEVEL`, `CHECK_INTERVAL_MINUTES` (default 60), `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` (eBay disabled with a startup warning when either is unset), `IMAGE_MATCH_THRESHOLD`, `IMAGE_MODEL` (default chosen in Task 7), `MODEL_CACHE_DIR` (default `./models`).
- Shop URLs: `https://shop-sammel-ente.de/Minecraft/Serie-3/?p=<n>`, `https://www.blue-ocean.de/produkte/lego/lego-minecraft/lego-minecraft-sticker-cards/?p=<n>`.

## Review Focus

- A shop page that parses to zero cards (layout change, Cloudflare page, maintenance) must count as a shop error with an admin alert, and must not mark that shop's stored listings unavailable. → tests in Task 5 (adapter throws) and Task 9 (runner keeps state).
- `/admin map` overrides must survive the next scrape of the same listing (the rescrape must not overwrite the card ids). → test in Task 8.
- Sold out → back in stock re-notifies exactly once; staying in stock across runs never re-notifies. → test in Task 8.
- A user with DMs closed must not stop the other users' notifications, and their notification is not recorded as sent (so it arrives once DMs work). → test in Task 9.
- `/missing set` with any unknown token (typo, card not in catalog) changes nothing and names the bad tokens; partial application would silently lose cards. → test in Task 4.

---

## File Structure

```
.mise.toml, bin/mise, package.json, bunfig.toml, tsconfig.bot.json, drizzle.config.ts,
eslint.config.mjs, .prettierrc, .prettierignore, .syncpackrc.json, .commitlintrc.json,
.gitleaks.toml, .gitleaksignore, .husky/{pre-commit,commit-msg,pre-push}, .gitignore,
.dockerignore, .env.example, Dockerfile, docker-compose.example.yml, LICENSE, README.md,
CLAUDE.md, DCO.md, docs/*.md, .github/workflows/*.yml, .github/dependabot.yml
scripts/measure-threshold.ts      dev tool: similarity distribution for the 19 known pairs
scripts/download-model.ts         pre-downloads IMAGE_MODEL into MODEL_CACHE_DIR (Docker build)
src/test/setup.ts                 test preload (in-memory DB, migrations path)
src/test/fixtures/                saved real HTML pages + eBay JSON
src/bot/bot.ts                    entrypoint, wiring, interaction routing, shutdown
src/bot/config.ts                 env parsing/validation
src/bot/utils/{logger,async,http}.ts
src/bot/cards/cardId.ts           id normalisation, list parsing/formatting
src/bot/cards/starterCatalog.ts   committed checklist (228 + LE1–LE22 + XXL1)
src/bot/database/db.ts, schema/*.ts, migrations/
src/bot/database/{catalogManager,userManager,listingManager,reportManager,runManager}.ts
src/bot/shops/types.ts            Listing, ShopAdapter, errors
src/bot/shops/{sammelEnte,blueOcean,ebay}.ts
src/bot/matcher/{similarity,embedder}.ts
src/bot/check/{runner,scheduler}.ts
src/bot/notify/{messages,sender}.ts
src/bot/commands/{missing,help,admin}.ts
src/bot/interactions/{report,catalogImport}.ts
```

---

### Task 1: Project scaffold and tooling

**Files:**
- Create: everything in the first block of the file structure above, plus `src/bot/utils/logger.ts`, `src/bot/utils/async.ts`, `src/bot/utils/async.test.ts`, `src/test/setup.ts`
- Modify: `.mise.toml` (keep the user's `[tools]` block, add ref's `[vars]`-free task set)

**Interfaces:**
- Produces: `logger` (default export, winston, `LOG_LEVEL`), `sleep(ms: number): Promise<void>`, `errorMessage(e: unknown): string` — same as ref `src/bot/utils/async.ts`.

- [ ] **Step 1:** Copy from ref: `bin/mise`, `bunfig.toml`, `tsconfig.bot.json`, `eslint.config.mjs`, `.prettierrc`, `.prettierignore`, `.syncpackrc.json`, `.commitlintrc.json`, `.gitleaks.toml`, `.gitattributes`, `.gitignore`, `.dockerignore`, `DCO.md`, `.husky/pre-commit`, `.husky/commit-msg`, `src/bot/utils/logger.ts`, `src/bot/utils/async.ts` (+ its test). Rewrite `.husky/pre-push` DCO check in POSIX sh (loop with `while read`, count unsigned commits in a variable, no arrays). Copy `.mise.toml` tasks: install, ci:install, prod:install, dev, build, prod:build, typecheck, test, test:coverage, lint, lint:fix, format, format:check, gitleaks, commitlint, db:generate, db:studio, audit, outdated, docker-build/up/down/logs (container name `minecraft-cards`). Drop ref-only tasks (credentials, deps:*, audit:pr) for now.
- [ ] **Step 2:** `package.json`: name `minecraft-cards-bot`, version `0.1.0`, license `MIT`, scripts as ref (build entry `src/bot/bot.ts`), dependencies `discord.js`, `drizzle-orm`, `winston`, `cheerio`, `@huggingface/transformers`; devDependencies as ref. Run `./bin/mise run install`.
- [ ] **Step 3:** `src/test/setup.ts`: `DB_PATH=':memory:'`, `MIGRATIONS_PATH` → `src/bot/database/migrations`, `BOT_ADMIN_ID='100'`, `DISCORD_TOKEN='test'`. `LICENSE` MIT, copyright `2026 Michael Cramer`. Minimal `README.md` and `CLAUDE.md` (commands section as ref, architecture filled in by later tasks).
- [ ] **Step 4:** Verify: `./bin/mise run typecheck && ./bin/mise run lint && ./bin/mise run test && ./bin/mise run format:check` — all exit 0.
- [ ] **Step 5:** Commit `chore: scaffold project tooling from IdleCodeRedeemer`.

### Task 2: Card ids and list parsing

**Files:** Create `src/bot/cards/cardId.ts`, `src/bot/cards/cardId.test.ts`, `src/bot/cards/starterCatalog.ts`, `src/bot/cards/starterCatalog.test.ts`

**Interfaces:**
- Produces:
  - `type CardId = string`, `type CardType = 'base' | 'le' | 'xxl'`
  - `normalizeCardId(raw: string): CardId | null` — accepts `12`, `012`, `#12`, `LE8`, `#LE008`, `le 8`, `XXL1`; rejects `0`, empty, other text.
  - `cardType(id: CardId): CardType`
  - `compareCardIds(a: CardId, b: CardId): number` — base numeric, then LE numeric, then XXL numeric.
  - `parseCardList(input: string): { ids: CardId[]; invalid: string[] }` — comma-separated, trims, case-insensitive, ranges `20-25`, `LE1-LE5`, `LE1-5`; reversed or mixed-type ranges and ranges over 300 ids are invalid; output deduped and sorted.
  - `formatCardList(ids: CardId[]): string` — sorted, consecutive runs compressed.
  - `parseChecklist(text: string): { ids: CardId[]; invalid: string[] }` — drops lines that end with `:` (the laststicker header), then `parseCardList` on the rest.
  - `STARTER_CHECKLIST: string` — the exact checklist line from the spec (`1, 2, …, 228, LE1, …, LE22, XXL1`).

- [ ] **Step 1: Write failing tests**

```ts
expect(parseCardList('#012, 12 , LE008, le 8, 20-22, LE1-LE2, xxl1, foo, 0, 25-20')).toEqual({
  ids: ['12', '20', '21', '22', 'LE1', 'LE2', 'LE8', 'XXL1'],
  invalid: ['foo', '0', '25-20'],
});
expect(parseCardList('LE1-3').ids).toEqual(['LE1', 'LE2', 'LE3']);
expect(parseCardList('1-301').invalid).toEqual(['1-301']);
expect(formatCardList(['5', '1', '2', '3', '12', 'LE2', 'LE1', 'XXL1'])).toBe('1-3, 5, 12, LE1-LE2, XXL1');
expect(parseChecklist('Prüfliste für Nummern diese Sammlung:\n1, 2, LE1, XXL1')).toEqual({ ids: ['1', '2', 'LE1', 'XXL1'], invalid: [] });
const starter = parseChecklist(STARTER_CHECKLIST);
expect(starter.invalid).toEqual([]);
expect(starter.ids.length).toBe(251);
expect(starter.ids.filter((id) => cardType(id) === 'le').length).toBe(22);
```

- [ ] **Step 2:** Run `./bin/mise run test src/bot/cards` → FAIL (module not found).
- [ ] **Step 3:** Implement the functions above.
- [ ] **Step 4:** Run `./bin/mise run test src/bot/cards` → PASS.
- [ ] **Step 5:** Commit `feat(cards): parse and format card id lists`.

### Task 3: Database, schema and catalog

**Files:** Create `drizzle.config.ts` (as ref, default `./data/cards.db`), `src/bot/database/db.ts` (copy ref's, default path `data/cards.db`), `src/bot/database/schema/{index,users,cards,listings,notifications,reports,runs,imageEmbeddings,adminAlerts}.ts`, generated `src/bot/database/migrations/`, `src/bot/database/catalogManager.ts` + test.

**Tables** (camelCase fields, `casing: 'snake_case'`; all times integer ms):
- `users`: `discordId` text PK, `createdAt`, `dmFailedAt` nullable
- `wantedCards`: `discordId` FK users (cascade delete), `cardId` text; PK (discordId, cardId)
- `cards`: `cardId` PK, `type`, `name` nullable, `referenceImageUrl` nullable, `updatedAt`
- `listings`: `id` integer PK auto, `shop`, `url` unique, `title`, `imageUrl` nullable, `priceCents` nullable, `currency` nullable, `format` (`shop`|`auction`|`fixed_price`), `auctionEndsAt` nullable, `available` boolean, `availableSince` nullable, `matchStatus`, `similarity` real nullable, `onHold` boolean default false, `manualOverride` boolean default false, `firstSeenAt`, `lastSeenAt`
- `listingCards`: `listingId` FK listings (cascade), `cardId`; PK (listingId, cardId)
- `notifications`: `discordId`, `listingId`, `availableSince`; unique (discordId, listingId, availableSince)
- `reports`: `id` PK auto, `listingId`, `reporterId`, `reason` (`wrong_number`|`wrong_series`|`other`), `note` nullable, `createdAt`, `resolvedAt` nullable
- `runs`: `id` PK auto, `startedAt`, `finishedAt`, `summary` text (JSON of `RunSummary`, Task 9)
- `imageEmbeddings`: `imageUrl` PK, `model` text, `embedding` blob (Float32 bytes), `createdAt`
- `adminAlerts`: `key` PK, `lastSentAt`

**Interfaces:**
- Consumes: `parseChecklist`, `cardType`, `STARTER_CHECKLIST` (Task 2)
- Produces `catalogManager`:
  - `seedIfEmpty(): void` — inserts starter catalog when `cards` is empty
  - `knownIds(): Set<CardId>`
  - `getCard(id): { cardId; type; name: string | null; referenceImageUrl: string | null } | undefined`
  - `updateNamesAndReferences(entries: { cardId: CardId; name: string; imageUrl: string | null }[]): void` — only for ids in the catalog
  - `previewImport(ids: CardId[]): { counts: Record<CardType, number>; added: CardId[]; removed: CardId[]; removedStillWanted: { cardId: CardId; users: number }[] }`
  - `applyImport(ids: CardId[]): void` — inserts added, deletes removed from `cards` (wanted lists untouched)

- [ ] **Step 1:** Write schema files, run `./bin/mise run db:generate`; commit generated migration with the schema.
- [ ] **Step 2: Failing tests** in `catalogManager.test.ts` (fresh in-memory DB via `initializeDatabase()` + table cleanup in `beforeEach`):

```ts
catalogManager.seedIfEmpty();
expect(catalogManager.knownIds().size).toBe(251);
catalogManager.seedIfEmpty(); // idempotent
expect(catalogManager.knownIds().size).toBe(251);
// a user wants LE22, then the import drops LE22 and adds LE23
const p = catalogManager.previewImport([...base228, ...le1to21, 'LE23', 'XXL1']);
expect(p.added).toEqual(['LE23']);
expect(p.removed).toEqual(['LE22']);
expect(p.removedStillWanted).toEqual([{ cardId: 'LE22', users: 1 }]);
catalogManager.applyImport([...]);
expect(catalogManager.knownIds().has('LE22')).toBe(false);
expect(userWanted('u1')).toContain('LE22'); // wanted list untouched
catalogManager.updateNamesAndReferences([{ cardId: '12', name: 'Squid', imageUrl: 'https://x/12.jpg' }, { cardId: '999', name: 'Nope', imageUrl: null }]);
expect(catalogManager.getCard('12')?.name).toBe('Squid');
expect(catalogManager.getCard('999')).toBeUndefined();
```

(Insert the wanted row directly with Drizzle in this test; `userManager` comes in Task 4.)
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement. **Step 5:** Run → PASS.
- [ ] **Step 6:** Commit `feat(database): add schema and card catalog`.

### Task 4: Per-user wanted lists

**Files:** Create `src/bot/database/userManager.ts` + test.

**Interfaces:**
- Consumes: `parseCardList`, `formatCardList` (Task 2), `catalogManager.knownIds()` (Task 3)
- Produces `userManager`:
  - `type ListChange = { ok: true; ids: CardId[] } | { ok: false; invalid: string[] }` (`invalid` = unparseable tokens plus parsed ids not in the catalog)
  - `setList(discordId, input: string): ListChange`, `addToList(discordId, input): ListChange`, `removeFromList(discordId, input): ListChange` (remove ignores catalog membership, so removed-from-catalog ids can be removed), `clearList(discordId): void`, `getList(discordId): CardId[]`
  - `allWantedIds(): Set<CardId>`, `usersWanting(cardIds: CardId[]): Map<string, CardId[]>` (discordId → which of those ids they want)
  - `markDmFailed(discordId, at: number): void`, `takeDmFailure(discordId): boolean` (returns true once and clears)

- [ ] **Step 1: Failing tests:**

```ts
expect(userManager.setList('u1', '12, 45, LE8')).toEqual({ ok: true, ids: ['12', '45', 'LE8'] });
expect(userManager.setList('u1', '12, 999, abc')).toEqual({ ok: false, invalid: ['abc', '999'] });
expect(userManager.getList('u1')).toEqual(['12', '45', 'LE8']); // unchanged after failed set
userManager.addToList('u1', '1-3');
userManager.removeFromList('u1', '45');
expect(userManager.getList('u1')).toEqual(['1', '2', '3', '12', 'LE8']);
userManager.setList('u2', '12');
expect(userManager.usersWanting(['12', '3'])).toEqual(new Map([['u1', ['3', '12']], ['u2', ['12']]]));
userManager.markDmFailed('u1', 1);
expect(userManager.takeDmFailure('u1')).toBe(true);
expect(userManager.takeDmFailure('u1')).toBe(false);
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (create user row on first write; `invalid` order: unparseable first, then unknown ids sorted). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(database): manage per-user missing lists`.

### Task 5: Shop adapters (sammel-ente, blue-ocean)

**Files:** Create `src/bot/utils/http.ts` + test, `src/bot/shops/types.ts` + test, `src/bot/shops/sammelEnte.ts` + test, `src/bot/shops/blueOcean.ts` + test, fixtures `src/test/fixtures/sammel-ente-p1.html`, `sammel-ente-p11.html`, `blue-ocean-p1.html`, `blue-ocean-p2.html`, `blue-ocean-p99.html`. Modify `.gitleaksignore`/`.gitleaks.toml` allowlist for `src/test/fixtures/` (blue-ocean pages embed a public storefront access token that gitleaks flags).

**Interfaces:**
- Produces (`types.ts`):

```ts
export type ShopId = 'sammel-ente' | 'blue-ocean' | 'ebay';
export interface Money { cents: number; currency: string }
export interface Listing {
  shop: ShopId; url: string; title: string; cardIds: CardId[];
  cardName: string | null;          // sammel-ente only: name from title
  imageUrl: string | null; price: Money | null; available: boolean;
  format: 'shop' | 'auction' | 'fixed_price'; auctionEndsAt: number | null;
  idConflict: boolean;              // blue-ocean URL vs image number disagree
}
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export interface ShopAdapter { id: ShopId; fetchListings(): Promise<Listing[]> }
export class ShopLayoutError extends Error {}   // page fetched but no cards parsed
```

- `http.ts`: `fetchText(url: string, fetchFn?: FetchFn): Promise<string>` — UA/timeout from Global Constraints, throws `HttpError(status, url)` on non-2xx.
- `parseSammelEntePage(html: string): { listings: Listing[]; lastPage: number }` and `createSammelEnteAdapter(fetchFn?: FetchFn): ShopAdapter` (fetches p1, then 2..lastPage with delay).
- `parseBlueOceanPage(html: string): { listings: Listing[]; productCount: number }` (`productCount` counts all product boxes, cards or not) and `createBlueOceanAdapter(fetchFn?: FetchFn): ShopAdapter` (pages 1.. until `productCount === 0`, hard cap 60 pages).

Parsing rules (verify against fixtures):
- sammel-ente: product box `.card.product-box`; title `a.product-name`; card id from `#NNN` / `#LENNN` in title, XXL from product code `MNC-03XX-XXL-NNNN` in href; skip boxes without an id (boosters, starter packs, `PZL`). `cardName` = title text after the id. Available iff `.delivery-information.delivery-available` present. Image `img.product-image` `src`. Price from the box's price element, `€` German format (`0,99 €` → 99 cents EUR).
- blue-ocean: link `a[data-testid="product-box-product-name-link"]`; only titles containing `LEGO Minecraft TCC`; card id = trailing number of the href (`…-2dd00088-12` → `12`), ignore the title's `Nr.`; image `img[data-testid="product-box-img"]` `src`, number from `P<n>` in the file name; `idConflict` when both exist and differ. Available iff stock text `Auf Lager`. Price from `[data-testid="product-box-product-price"]` (`5.99` → 599 EUR). How LE/XXL appear on blue-ocean is not known: if the fixtures show any, map them; otherwise a card-like TCC product whose id can't be read is skipped and logged at `warn`.
- Either adapter throws `ShopLayoutError` when the whole run parsed zero card listings.

- [ ] **Step 1:** Save fixtures with `curl -sSL -A 'minecraft-cards-bot/1.0 (+hourly stock check)' -o <fixture> <url>` for the five pages above.
- [ ] **Step 2: Failing tests:**

```ts
const p1 = parseSammelEntePage(readFixture('sammel-ente-p1.html'));
expect(p1.lastPage).toBe(11);
const squid = p1.listings.find((l) => l.cardIds[0] === '12')!;
expect(squid).toMatchObject({ shop: 'sammel-ente', cardName: 'Squid', format: 'shop',
  url: 'https://shop-sammel-ente.de/LEGO-Minecraft-Serie-3-012-Squid/MNC-03XX-BAS-0012' });
expect(p1.listings.some((l) => l.title.includes('Booster'))).toBe(false);
// availability as captured in the fixture: #12 available, #2 sold out
expect(squid.available).toBe(true);
expect(p1.listings.find((l) => l.cardIds[0] === '2')!.available).toBe(false);

const b1 = parseBlueOceanPage(readFixture('blue-ocean-p1.html'));
const bSquid = b1.listings.find((l) => l.url.endsWith('-2dd00088-12'))!;
expect(bSquid.cardIds).toEqual(['12']);           // title says "Nr. 9"
expect(bSquid.idConflict).toBe(false);
expect(b1.listings.find((l) => l.url.endsWith('-107'))!.cardIds).toEqual(['107']);
expect(b1.listings.every((l) => l.title.includes('LEGO Minecraft TCC'))).toBe(true);
expect(parseBlueOceanPage(readFixture('blue-ocean-p99.html')).productCount).toBe(0);

// adapter with fake fetch: page 1 returns a non-shop HTML page
await expect(createSammelEnteAdapter(fakeFetch({ '?p=1': '<html>Just a moment...</html>' })).fetchListings())
  .rejects.toBeInstanceOf(ShopLayoutError);
```

(If the live fixture shows different stock states, adjust the two availability expectations to the fixture, keeping one available and one sold-out assertion.)
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement with cheerio. **Step 5:** Run → PASS.
- [ ] **Step 6:** Commit `feat(shops): parse sammel-ente and blue-ocean listings`.

### Task 6: eBay adapter

**Files:** Create `src/bot/shops/ebay.ts` + test, fixtures `src/test/fixtures/ebay-token.json`, `ebay-search.json` (hand-written in the Browse API response shape, 5 items: single card fixed price, auction with `currentBidPrice` + shipping, bundle `#12, #45 und LE8`, a listing with no id, a `12/228` title).

**Interfaces:**
- Consumes: `Listing`, `FetchFn`, `ShopAdapter`, `normalizeCardId`
- Produces:
  - `extractCardIdsFromTitle(title: string): CardId[]`, recognising only prefixed forms: `#12`, `Nr. 12`, `Nr.12`, `No. 12`, `Karte 12`, `Card 12`, `12/228`, `LE8`/`LE 08`, `XXL1`, and lists after a prefix (`Nr. 12, 45 und 107`). Bare numbers never count (`Serie 3`, `2026`, `228`).
  - `createEbayAdapter(opts: { clientId: string; clientSecret: string; fetchFn?: FetchFn }): ShopAdapter & { lastSkippedNoId: number }`
- Token: `POST https://api.ebay.com/identity/v1/oauth2/token`, Basic auth, `grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope`; cache until `expires_in - 60 s`.
- Search: `GET https://api.ebay.com/buy/browse/v1/item_summary/search?q=<q>&limit=200`, header `X-EBAY-C-MARKETPLACE-ID: EBAY_DE`, for each of `EBAY_QUERIES = ['lego minecraft on fire karte', 'lego minecraft tcc serie 3', 'lego minecraft trading card on fire']`; dedupe by `itemId`.
- Mapping: `url = itemWebUrl`, `imageUrl = image.imageUrl`, `available = true`, `format = buyingOptions.includes('AUCTION') ? 'auction' : 'fixed_price'`, price = (`currentBidPrice` for auctions else `price`) + `shippingOptions[0].shippingCost` when present, `auctionEndsAt = Date.parse(itemEndDate)` for auctions. Items with no id are not returned; they are counted in `lastSkippedNoId`.

- [ ] **Step 1: Failing tests:**

```ts
expect(extractCardIdsFromTitle('LEGO Minecraft On Fire Karte Nr. 12 Squid')).toEqual(['12']);
expect(extractCardIdsFromTitle('Lego Minecraft TCC Serie 3 #12, #45 und LE8')).toEqual(['12', '45', 'LE8']);
expect(extractCardIdsFromTitle('Minecraft Serie 3 Karte 107/228 2026')).toEqual(['107']);
expect(extractCardIdsFromTitle('LEGO Minecraft Serie 3 Booster 2026')).toEqual([]);
const adapter = createEbayAdapter({ clientId: 'id', clientSecret: 'secret', fetchFn: fixtureFetch });
const listings = await adapter.fetchListings();
expect(listings).toHaveLength(4);
expect(adapter.lastSkippedNoId).toBe(1);
expect(listings.find((l) => l.format === 'auction')).toMatchObject({ price: { cents: 149 + 160, currency: 'EUR' } });
expect(tokenRequests(fixtureFetch)).toBe(1); // cached across the 3 queries
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(ebay): search eBay listings via the Browse API`.

### Task 7: Image embedder and threshold

**Files:** Create `src/bot/matcher/similarity.ts` + test, `src/bot/matcher/embedder.ts` + test, `scripts/measure-threshold.ts`, `scripts/download-model.ts`.

**Interfaces:**
- Produces:
  - `cosineSimilarity(a: Float32Array, b: Float32Array): number`
  - `interface ImageEmbedder { model: string; embed(imageUrl: string): Promise<Float32Array> }`
  - `createTransformersEmbedder(opts: { model: string; cacheDir: string }): Promise<ImageEmbedder>` — `@huggingface/transformers` `pipeline('image-feature-extraction', model)`, `env.cacheDir = cacheDir`, pooled + L2-normalised output.
  - `createCachedEmbedder(inner: ImageEmbedder): ImageEmbedder` — reads/writes `imageEmbeddings` by (url, model); a model change invalidates rows.
  - `type MatchStatus = 'reference' | 'confirmed' | 'unconfirmed' | 'no_reference' | 'model_unavailable' | 'bundle'`
  - `matchListing(listing: Listing, reference: string | null, embedder: ImageEmbedder | null, threshold: number): Promise<{ status: MatchStatus; similarity: number | null }>` — sammel-ente → `reference`; >1 card id → `bundle`; no reference → `no_reference`; embedder null or throws → `model_unavailable` (logged at `warn`, never thrown); else `confirmed` iff similarity ≥ threshold and not `idConflict`.

- [ ] **Step 1: Failing tests** (`embedder.test.ts` uses a fake inner embedder returning fixed vectors):

```ts
expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1);
expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
const cached = createCachedEmbedder(fake);
await cached.embed('u'); await cached.embed('u');
expect(fake.calls).toBe(1);
expect((await matchListing(blue12, 'ref12', fakeSame, 0.85)).status).toBe('confirmed');
expect((await matchListing(blue12, 'ref12', fakeDifferent, 0.85)).status).toBe('unconfirmed');
expect((await matchListing({ ...blue12, idConflict: true }, 'ref12', fakeSame, 0.85)).status).toBe('unconfirmed');
expect((await matchListing(blue12, 'ref12', throwingEmbedder, 0.85)).status).toBe('model_unavailable');
expect((await matchListing(bundle, 'ref12', fakeSame, 0.85)).status).toBe('bundle');
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Choose the model and threshold.** `scripts/measure-threshold.ts` fetches both shops' page 1 (adapters from Task 5), pairs blue-ocean ↔ sammel-ente listings by card id (true pairs) and by shifting ids by one (false pairs), and prints min/median/max similarity for each group, for `Xenova/clip-vit-base-patch32` and `Xenova/dinov2-small`. Run `bun run scripts/measure-threshold.ts` (add mise task `measure:threshold`). Pick the model with the widest gap; set `IMAGE_MODEL` default and `IMAGE_MATCH_THRESHOLD` default to the midpoint of the gap in `config.ts` (Task 14) and `.env.example`, and record the measured numbers in `docs/image-matching.md`.
- [ ] **Step 6: Compiled-binary spike.** Write a 10-line throwaway `scratch/embed-spike.ts` that embeds one image, build it with `bun build --compile`, and run the binary. Record in `docs/image-matching.md` whether it works. If it fails, Task 15 uses the `bun run` image variant. Delete the spike file.
- [ ] **Step 7:** `scripts/download-model.ts` loads `IMAGE_MODEL` once into `MODEL_CACHE_DIR` (mise task `model:download`).
- [ ] **Step 8:** Commit `feat(matcher): compare listing images with local embeddings`.

### Task 8: Listing store and notification diff

**Files:** Create `src/bot/database/listingManager.ts` + test.

**Interfaces:**
- Consumes: `Listing`, `MatchStatus`, `userManager.usersWanting`
- Produces `listingManager`:
  - `upsertFromRun(shop: ShopId, listings: Listing[], now: number): StoredListing[]` — insert or update by `url`; sets `availableSince = now` when a listing becomes available (new, or previously unavailable), clears it when unavailable; listings of that shop not in `listings` become unavailable; when `manualOverride` is set, the stored card ids are kept. Only called for shops whose fetch succeeded.
  - `setMatch(listingId: number, status: MatchStatus, similarity: number | null): void`
  - `type StoredListing = { id; shop; url; title; imageUrl; price: Money | null; format; auctionEndsAt; available; availableSince: number | null; cardIds: CardId[]; matchStatus: MatchStatus; similarity: number | null; onHold: boolean; manualOverride: boolean }`
  - `pendingNotifications(): Map<string, { listing: StoredListing; cardIds: CardId[] }[]>` — per user: listings that are available, not on hold, share a card with the user's list, and have no `notifications` row for (user, listing, availableSince)
  - `recordNotified(discordId: string, listingId: number, availableSince: number): void`
  - `getByUrl(url): StoredListing | undefined`, `getById(id)`
  - `overrideCards(url: string, cardIds: CardId[], now: number): StoredListing | undefined` — replaces card ids, `manualOverride = true`, `onHold = false`, resolves open reports, sets `availableSince = now` if available (so users of the new card ids are notified)
  - `clearHold(url: string): StoredListing | undefined` — `onHold = false`, resolves open reports
  - `setOnHold(listingId: number): void`

- [ ] **Step 1: Failing tests:**

```ts
userManager.setList('u1', '12');
listingManager.upsertFromRun('blue-ocean', [blue12Available], 1000);
expect(listingManager.pendingNotifications().get('u1')).toHaveLength(1);
const l = listingManager.getByUrl(blue12Available.url)!;
listingManager.recordNotified('u1', l.id, l.availableSince!);
listingManager.upsertFromRun('blue-ocean', [blue12Available], 2000);    // still in stock
expect(listingManager.pendingNotifications().get('u1') ?? []).toHaveLength(0);
listingManager.upsertFromRun('blue-ocean', [{ ...blue12Available, available: false }], 3000);
listingManager.upsertFromRun('blue-ocean', [blue12Available], 4000);    // back in stock
expect(listingManager.pendingNotifications().get('u1')).toHaveLength(1);
listingManager.upsertFromRun('blue-ocean', [], 5000);                   // vanished → unavailable
expect(listingManager.getByUrl(blue12Available.url)!.available).toBe(false);

// override survives rescrape
listingManager.upsertFromRun('blue-ocean', [blue12Available], 6000);
listingManager.overrideCards(blue12Available.url, ['8'], 6500);
listingManager.upsertFromRun('blue-ocean', [blue12Available], 7000);
expect(listingManager.getByUrl(blue12Available.url)!.cardIds).toEqual(['8']);

// hold blocks notifications
listingManager.setOnHold(l.id);
expect(listingManager.pendingNotifications().get('u1') ?? []).toHaveLength(0);
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(database): store listings and compute pending notifications`.

### Task 9: Check runner and scheduler

**Files:** Create `src/bot/check/runner.ts` + test, `src/bot/check/scheduler.ts` + test, `src/bot/database/runManager.ts` + test (runs + adminAlerts).

**Interfaces:**
- Consumes: adapters (Tasks 5–6), `catalogManager`, `userManager`, `listingManager`, `matchListing`, Task 10's `NotificationSender`
- Produces:

```ts
export interface RunSummary {
  startedAt: number; finishedAt: number;
  shops: Partial<Record<ShopId, { listings: number; error?: string; skippedNoId?: number }>>;
  notified: number; dmFailures: number;
}
export interface RunDeps {
  adapters: ShopAdapter[]; embedder: ImageEmbedder | null; threshold: number;
  sender: NotificationSender; alertAdmin: (text: string) => Promise<void>; now: () => number;
}
export function runCheck(deps: RunDeps): Promise<RunSummary>;
export function createScheduler(run: () => Promise<RunSummary>, intervalMs: number):
  { start(): void; stop(): void; trigger(): Promise<RunSummary | 'busy'> };
```

- `runManager`: `record(summary: RunSummary): void`, `last(): RunSummary | undefined`, `shouldAlert(key: string, now: number, everyMs: number): boolean` (true and updates `lastSentAt` when due).
- Order in `runCheck`: if `userManager.allWantedIds()` is empty, record and return with no fetches. Else, for each adapter: fetch (error → `shops[id].error`, admin alert through `shouldAlert('shop-error:' + id, now, 24 h)`, skip upsert) → upsert. sammel-ente results also feed `catalogManager.updateNamesAndReferences`. Then `matchListing` for stored available listings with a wanted card whose image changed or status is unset, then `sender.send(pendingNotifications())`, then `runManager.record`.
- Scheduler: `start()` runs once immediately, then every `intervalMs`; a tick while running is skipped; `trigger()` returns `'busy'` while running.

- [ ] **Step 1: Failing tests** (fake adapters/sender/embedder):

```ts
// failing shop keeps its stored state
await runCheck(depsWith([okBlue(blue12Available)]));
const s = await runCheck(depsWith([failingBlue(new ShopLayoutError('no cards'))]));
expect(s.shops['blue-ocean']!.error).toContain('no cards');
expect(listingManager.getByUrl(blue12Available.url)!.available).toBe(true);
expect(alerts).toHaveLength(1);
await runCheck(depsWith([failingBlue(new ShopLayoutError('no cards'))]));
expect(alerts).toHaveLength(1); // throttled to once per 24 h

// DM failure for one user does not block others and is retried next run
userManager.setList('u1', '12'); userManager.setList('u2', '12');
sender.failFor('u1');
const r = await runCheck(depsWith([okBlue(blue12Available)]));
expect(r.notified).toBe(1);
expect(r.dmFailures).toBe(1);
sender.failFor(null);
expect((await runCheck(depsWith([okBlue(blue12Available)]))).notified).toBe(1); // u1 now

// no wanted cards → no fetch
expect(fetchCount).toBe(0);

const sched = createScheduler(slowRun, 60_000);
const first = sched.trigger();
expect(await sched.trigger()).toBe('busy');
await first;
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(bot): run hourly shop checks`.

### Task 10: Notification messages and sender

**Files:** Create `src/bot/notify/messages.ts` + test, `src/bot/notify/sender.ts` + test.

**Interfaces:**
- Consumes: `StoredListing`, `catalogManager.getCard`, `formatCardList`
- Produces:
  - `kleinanzeigenSearchUrl(cardId: CardId): string` → `https://www.kleinanzeigen.de/s-lego-minecraft-karte-<id lowercased>/k0`
  - `buildNotificationMessages(items: { listing: StoredListing; cardIds: CardId[] }[]): MessageCreateOptions[]` — max 5 items per message; per item one embed + one `ActionRowBuilder` with link button "Open in shop" (`listing.url`), link button "Kleinanzeigen" (first card id), secondary button "❌ Wrong card" with `customId = 'report:' + listing.id`.
  - Embed: title `🟢 Card #12 Squid is available` (bundle: `🟢 Bundle with #12, #45 on eBay`; name omitted when unknown); fields shop, price (`0,99 €`, auctions add `Auction · ends <t:unix:R>`); image = listing image; footer by match status: `✅ picture matches reference (0.94)`, `⚠️ number unconfirmed — compare with the reference` (reference image as thumbnail), `ℹ️ bundle — check the listing`, `ℹ️ no reference picture yet`, `ℹ️ picture check unavailable`; `reference` status (sammel-ente) shows no footer.
  - `interface NotificationSender { send(pending: Map<string, { listing: StoredListing; cardIds: CardId[] }[]>): Promise<{ notified: number; dmFailures: number }> }`
  - `createDiscordSender(client: Client): NotificationSender` — per user: fetch user, send each message (500 ms between sends), `recordNotified` per item only after its message succeeded; on failure `userManager.markDmFailed` and continue with the next user.

- [ ] **Step 1: Failing tests:**

```ts
const msgs = buildNotificationMessages(Array.from({ length: 7 }, (_, i) => item(i)));
expect(msgs).toHaveLength(2);
expect(msgs[0].embeds).toHaveLength(5);
expect(msgs[0].components).toHaveLength(5);
const row = msgs[0].components![0].toJSON();
expect(row.components.map((c: any) => c.label)).toEqual(['Open in shop', 'Kleinanzeigen', '❌ Wrong card']);
expect(row.components[2].custom_id).toBe('report:1');
expect(kleinanzeigenSearchUrl('LE8')).toBe('https://www.kleinanzeigen.de/s-lego-minecraft-karte-le8/k0');
expect(embedJson(item0Unconfirmed).footer.text).toContain('⚠️ number unconfirmed');
expect(embedJson(item0Unconfirmed).thumbnail.url).toBe(referenceUrl);
// sender: fake client whose send throws for 'u1'
const r = await createDiscordSender(fakeClient({ failFor: 'u1' })).send(pendingFor(['u1', 'u2']));
expect(r).toEqual({ notified: 1, dmFailures: 1 });
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(notify): send batched availability DMs`.

### Task 11: User commands

**Files:** Create `src/bot/commands/missing.ts` + test, `src/bot/commands/help.ts` + test. Copy ref `src/bot/utils/interactionReply.ts` + test.

**Interfaces:**
- Consumes: `userManager`, `formatCardList`
- Produces: each module exports `data: SlashCommandBuilder` and `execute(interaction: ChatInputCommandInteraction): Promise<void>` (ref pattern).
- `/missing` subcommands: `set list:<string>`, `add list:<string>`, `remove list:<string>`, `list`, `clear`. All replies ephemeral. Success reply: `Your missing cards (N): <formatCardList>`. Failure reply: `Nothing changed. Unknown or invalid: <tokens joined by ", ">`. String option `max_length` 6000.
- `/help`: one embed describing `/missing` with examples `12, 45, LE8`, `20-25`, and the wrong-card button.

- [ ] **Step 1: Failing tests** with a fake interaction object (`options.getSubcommand()`, `options.getString()`, captured `reply` payload):

```ts
await execute(fakeInteraction('u1', 'set', '12, 45'));
expect(lastReply().content).toBe('Your missing cards (2): 12, 45');
await execute(fakeInteraction('u1', 'add', '12, 9999'));
expect(lastReply().content).toBe('Nothing changed. Unknown or invalid: 9999');
expect(lastReply().flags).toBe(MessageFlags.Ephemeral);
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(commands): add /missing and /help`.

### Task 12: Wrong-card report flow

**Files:** Create `src/bot/database/reportManager.ts` + test, `src/bot/interactions/report.ts` + test.

**Interfaces:**
- Consumes: `listingManager`, `catalogManager`, `config.botAdminId`
- Produces:
  - `reportManager.create(r: { listingId: number; reporterId: string; reason: 'wrong_number' | 'wrong_series' | 'other'; note: string | null; now: number }): number` — inserts and calls `listingManager.setOnHold`
  - `handleReportButton(i: ButtonInteraction)` for `report:<listingId>` → ephemeral reply with three buttons `report-reason:<id>:wrong_number` ("Wrong number"), `…:wrong_series` ("Wrong series"), `…:other` ("Other")
  - `handleReportReason(i: ButtonInteraction)` → `showModal` id `report-modal:<id>:<reason>` with one optional paragraph input `note` (max 500)
  - `handleReportModal(i: ModalSubmitInteraction, notifyAdmin: (msg: MessageCreateOptions) => Promise<void>)` → creates report, DMs admin, replies ephemeral `Thanks — the admin has been notified. This listing is paused until it's checked.`
  - `buildAdminReportMessage(report, listing: StoredListing, reporterTag: string): MessageCreateOptions` — embed with reporter, card ids, shop, URL, reason, note, listing image, reference image as thumbnail; text tells the admin `/admin map url:<url> cards:<ids>` or `/admin clear url:<url>`.
- A listing id that no longer exists → ephemeral `This listing no longer exists.`

- [ ] **Step 1: Failing tests:**

```ts
const id = reportManager.create({ listingId: l.id, reporterId: 'u1', reason: 'wrong_number', note: 'shows #8', now: 1 });
expect(listingManager.getById(l.id)!.onHold).toBe(true);
await handleReportModal(fakeModal('report-modal:' + l.id + ':wrong_series', 'u1', ''), adminSpy);
expect(adminSpy.calls[0].embeds[0].toJSON().fields.find((f: any) => f.name === 'Reason').value).toBe('Wrong series');
expect(lastReply().content).toContain('admin has been notified');
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(commands): report wrong cards to the admin`.

### Task 13: Admin commands and catalog import

**Files:** Create `src/bot/commands/admin.ts` + test, `src/bot/interactions/catalogImport.ts` + test.

**Interfaces:**
- Consumes: `listingManager.overrideCards/clearHold`, `runManager.last`, scheduler `trigger()` (passed in), `catalogManager.previewImport/applyImport`, `parseChecklist`, `parseCardList`
- Produces:
  - `/admin` subcommands: `map url:<string> cards:<string>`, `clear url:<string>`, `status`, `run`; group `catalog` → `import list:<string max 6000>`. `execute(interaction, ctx: { trigger: () => Promise<RunSummary | 'busy'> })`. Any user other than `BOT_ADMIN_ID` gets ephemeral `Only the bot admin can use this.` and nothing runs.
  - `map`: ids via `parseCardList` (must all be known); unknown URL → `No stored listing with that URL.`
  - `status`: last run time, per shop listing count / error / eBay skipped, notified, DM failures.
  - `run`: `'busy'` → `A check is already running.`; else the summary.
  - `catalog import`: `parseChecklist`; any invalid token → reply listing them, nothing stored; else preview text `Catalog: 228 base, 22 LE, 1 XXL. Added: … Removed: … Still on someone's list: LE22 (1 user)` with buttons `catalog-save:<token>` / `catalog-cancel:<token>`; pending imports kept in memory 10 min (`createImportStore(now: () => number)` with `put(ids): token`, `take(token): CardId[] | undefined`); save → `applyImport`, reply `Catalog saved.`; expired token → `This import expired, run the command again.`

- [ ] **Step 1: Failing tests:**

```ts
await adminExecute(fakeInteraction('u1', 'status'), ctx);
expect(lastReply().content).toBe('Only the bot admin can use this.');
await adminExecute(fakeAdmin('catalog', 'import', 'Prüfliste für Nummern diese Sammlung:\n' + checklistWithLE23), ctx);
expect(lastReply().content).toContain('Added: LE23');
const store = createImportStore(() => clock);
const token = store.put(['1']);
clock += 11 * 60_000;
expect(store.take(token)).toBeUndefined();
await adminExecute(fakeAdmin(undefined, 'map', { url: blue12.url, cards: '8' }), ctx);
expect(listingManager.getByUrl(blue12.url)!.cardIds).toEqual(['8']);
ctx.trigger = async () => 'busy';
await adminExecute(fakeAdmin(undefined, 'run'), ctx);
expect(lastReply().content).toBe('A check is already running.');
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(admin): add admin commands and catalog import`.

### Task 14: Config and bot wiring

**Files:** Create `src/bot/config.ts` + test, `src/bot/bot.ts`, `.env.example`.

**Interfaces:**
- Produces: `loadConfig(env: Record<string, string | undefined>): Config` with `Config = { discordToken; guildId?; botAdminId; dbPath; checkIntervalMs; ebay: { clientId; clientSecret } | null; imageModel; imageMatchThreshold; modelCacheDir }`; throws `ConfigError` naming the variable for missing `DISCORD_TOKEN`/`BOT_ADMIN_ID`, non-numeric interval or threshold outside (0, 1).
- `bot.ts`: load config (exit 1 on `ConfigError`), `initializeDatabase()`, `catalogManager.seedIfEmpty()`, register commands statically (guild-scoped when `DISCORD_GUILD_ID` set), intents `Guilds` + `DirectMessages`. Create embedder via `createCachedEmbedder(await createTransformersEmbedder(...))`; on failure log `error` and run with `embedder = null`. Adapters: sammel-ente, blue-ocean, eBay only when configured (else log `warn` "eBay disabled: EBAY_CLIENT_ID/EBAY_CLIENT_SECRET not set"). On `ClientReady` start the scheduler. Route `InteractionCreate`: chat commands → modules; buttons by customId prefix (`report:`, `report-reason:`, `catalog-save:`, `catalog-cancel:`); modals `report-modal:`. Before each chat command, if `userManager.takeDmFailure(user)` add a follow-up `I couldn't send you a DM — please allow DMs from server members.` Errors through `replyWithError`. SIGINT/SIGTERM: stop scheduler, destroy client, `closeDatabase()`. `unhandledRejection`/`uncaughtException` guards as ref.

- [ ] **Step 1: Failing tests** for `loadConfig`:

```ts
expect(() => loadConfig({ BOT_ADMIN_ID: '1' })).toThrow('DISCORD_TOKEN');
expect(loadConfig({ DISCORD_TOKEN: 't', BOT_ADMIN_ID: '1' })).toMatchObject({ checkIntervalMs: 3_600_000, ebay: null, dbPath: './data/cards.db' });
expect(() => loadConfig({ DISCORD_TOKEN: 't', BOT_ADMIN_ID: '1', IMAGE_MATCH_THRESHOLD: '2' })).toThrow('IMAGE_MATCH_THRESHOLD');
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `config.ts`, `bot.ts`, `.env.example` (commented like ref's). **Step 4:** Run → PASS; `./bin/mise run typecheck && ./bin/mise run lint` exit 0.
- [ ] **Step 5: Manual smoke test** (needs a test bot token from the user): `./bin/mise run dev` with `.env`; in Discord `/missing set 12, LE8`, `/admin run`, confirm a DM arrives for any available card and the Wrong card flow reaches the admin.
- [ ] **Step 6:** Commit `feat(bot): wire commands, interactions and scheduler`.

### Task 15: Docker, CI and docs

**Files:** Create `Dockerfile`, `docker-compose.example.yml`, `.github/workflows/{test,codeql,dco-check,dependency-review,secrets,docker,scorecards,release-attestation,audit}.yml`, `.github/dependabot.yml`, `docs/{development,configuration,image-matching,deployment}.md`; update `README.md` (links every doc), `CLAUDE.md` (architecture + invariants from this plan's Global Constraints and Review Focus).

- [ ] **Step 1:** Ask the user for `uname -m` on the root server; x86_64 → as below, arm64 → make sure the onnxruntime build supports it before going on.
- [ ] **Step 2:** Dockerfile from ref. Builder also runs `bin/mise run model:download` with `MODEL_CACHE_DIR=/app/models`. Production stage copies `/app/models` and sets `MODEL_CACHE_DIR=/app/models`. If the Task 7 spike showed the compiled binary works: ref's binary layout. If not: production stage based on the same debian image with mise-installed Bun, `bun install --production --frozen-lockfile`, `CMD ["bun", "run", "src/bot/bot.ts"]`; record the reason in a Dockerfile comment.
- [ ] **Step 3:** Copy workflows from ref, replacing image/repo names with `bigmichi1/minecraft-cards` / `ghcr.io/bigmichi1/minecraft-cards`; keep coverage gate and DCO check.
- [ ] **Step 4:** Verify: `./bin/mise run docker-build` succeeds; `docker run --rm --env-file .env minecraft-cards` logs "Database migrations applied" and the embedder loads without network access to Hugging Face (`--network none` run of `scripts/download-model.ts` check: model is read from `/app/models`).
- [ ] **Step 5:** Full gate: `./bin/mise run typecheck && ./bin/mise run lint && ./bin/mise run format:check && ./bin/mise run test:coverage && ./bin/mise run gitleaks` → all exit 0.
- [ ] **Step 6:** Commit `ci: add Docker image, workflows and docs`.
