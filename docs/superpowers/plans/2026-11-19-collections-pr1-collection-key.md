# Collections PR 1: collection key everywhere — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every card, wanted entry and listing belongs to a collection; the only collection is
`lego-minecraft-3`, and the bot behaves exactly as before apart from a required `collection`
option on the commands.

**Architecture:** A collection registry (`src/bot/collections/`) names the collections. Migration
0005 adds the collection to `cards`, `wanted_cards` and `listings` and backfills
`lego-minecraft-3`. Managers, runner, adapters and commands take a `CollectionId` next to every
card id. Later PRs add collections, laststicker and per-collection id rules (spec, "Rollout in
steps" 2-5); each gets its own plan once this one is merged.

**Tech Stack:** Bun, TypeScript, discord.js, Drizzle ORM on SQLite, `bun test`, Mise tasks.

**Spec:** `docs/superpowers/specs/2026-11-19-multi-collection-design.md` (approved 2026-11-19).

## Global Constraints

- Every task runs through `./bin/mise run <task>` (`test`, `typecheck`, `lint`, `format:check`,
  `db:generate`); never `bun run`/`npm`/`npx` directly.
- Every non-test source file in `src/` has a `*.test.ts` next to it (exemptions: `bot.ts`,
  `database/schema/*.ts`, `src/test/`).
- Commits: Conventional Commits, scope from `bot`, `cards`, `database`, `shops`, `ebay`,
  `matcher`, `notify`, `commands`, `admin`, `ci`, `docs`, `docker`; `git commit -s`; message ends
  with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never `--no-verify`.
- Timestamps are integer epoch milliseconds. Card ids stay canonical strings (`"12"`, `"LE8"`).
- Collection id of all existing data: exactly `lego-minecraft-3`; display name
  `LEGO Minecraft Serie 3 "On Fire"`.
- No behaviour change besides the command option: every existing test keeps passing, adapted only
  for the collection argument.
- Branch from a freshly fetched `origin/main`; run the pr-review-toolkit on the PR before handing
  it over, and fix every finding.

## Review Focus

- Migration 0005 on a database with existing rows: every card, wanted entry, listing (with its
  `listing_cards`, `picture_card_id`, overrides) and notification survives, all under
  `lego-minecraft-3`; nobody is re-notified. Test: Task 2 (migration test on old-style rows).
- `/stock` buttons in DMs and channels sent before the deploy (`stock:<page>:<filter>`) keep
  working as `lego-minecraft-3`. Test: Task 6.
- A collection value that is not in the registry (a stale client, a crafted interaction) is
  answered with an ephemeral error and changes nothing. Test: Task 6.
- A sammel-ente fetch that fails still leaves stored listings untouched, and the unavailable
  marking of a run only touches listings of the same shop and collection. Test: Task 4.
- `/admin map` on a listing keeps working and its override still survives a rescrape (existing
  Review focus rule). Test: Task 4 (rescrape) and Task 6 (command).

---

### Task 1: Collection registry

**Files:**

- Create: `src/bot/collections/ids.ts`, `src/bot/collections/ids.test.ts`
- Create: `src/bot/collections/types.ts` (type only, no test needed beyond index test)
- Create: `src/bot/collections/legoMinecraft3.ts`
- Create: `src/bot/collections/index.ts`, `src/bot/collections/index.test.ts`

**Interfaces:**

- Produces:
  - `COLLECTION_IDS = ['lego-minecraft-3'] as const` and
    `type CollectionId = (typeof COLLECTION_IDS)[number]` in `ids.ts` (no other imports, so
    schema files can use it).
  - `isCollectionId(value: string): value is CollectionId` in `ids.ts`.
  - `DEFAULT_COLLECTION: CollectionId = 'lego-minecraft-3'` in `ids.ts` (legacy custom ids only).
  - `interface CollectionDefinition { id: CollectionId; name: string }` in `types.ts`.
  - `COLLECTIONS: readonly CollectionDefinition[]`, `collectionById(id: CollectionId):
CollectionDefinition`, `collectionChoices(): { name: string; value: CollectionId }[]` in
    `index.ts`.

- [ ] **Step 1: Write the failing tests**

`ids.test.ts`: `isCollectionId('lego-minecraft-3')` is true; `isCollectionId('lego-minecraft-9')`
and `isCollectionId('')` are false.
`index.test.ts`: `COLLECTIONS.map(c => c.id)` equals `[...COLLECTION_IDS]` (same order, every id
defined once); every id matches `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`;
`collectionById('lego-minecraft-3').name` is `LEGO Minecraft Serie 3 "On Fire"`;
`collectionChoices()` equals `[{ name: 'LEGO Minecraft Serie 3 "On Fire"', value: 'lego-minecraft-3' }]`.

- [ ] **Step 2: Run** `./bin/mise run test src/bot/collections` — expect FAIL (modules missing).
- [ ] **Step 3: Implement** the four files as in Interfaces; `legoMinecraft3.ts` exports
      `legoMinecraft3: CollectionDefinition`.
- [ ] **Step 4: Run** `./bin/mise run test src/bot/collections` — expect PASS; then
      `./bin/mise run typecheck`.
- [ ] **Step 5: Commit** `feat(cards): add the collection registry`.

### Task 2: Schema and migration 0005

**Files:**

- Modify: `src/bot/database/schema/cards.ts`, `src/bot/database/schema/users.ts` (wanted_cards),
  `src/bot/database/schema/listings.ts`
- Create (generated, then edited): `src/bot/database/migrations/0005_*.sql` plus `meta/`
- Test: `src/bot/database/db.test.ts`

**Interfaces:**

- Consumes: `COLLECTION_IDS`, `CollectionId` (Task 1).
- Produces: column `collection: text({ enum: COLLECTION_IDS }).$type<CollectionId>().notNull()` on
  `cards` (primary key becomes `primaryKey({ columns: [t.collection, t.cardId] })`),
  `wanted_cards` (key `[t.discordId, t.collection, t.cardId]`) and `listings` (plus index
  `listings_collection_shop_idx` on `(collection, shop)`). `listing_cards` and
  `picture_card_id` are read in the listing's collection (no column).

- [ ] **Step 1: Write the failing test** in `db.test.ts`, following the existing migration test at
      `db.test.ts:130-175`: apply the journal entries up to and including 0004 to a fresh
      `new Database(':memory:')`; insert a card `12` (name `Squid`, a reference URL), a user with
      wanted `12` and `LE8`, a listing with `listing_cards` `12`, `picture_card_id` `'45'`,
      `manual_override` 1, and a notification row; apply 0005; assert every row still exists with
      `collection = 'lego-minecraft-3'`, the notification row is untouched, and inserting a second
      card `('lego-minecraft-3','12')` violates the primary key.
- [ ] **Step 2: Run** `./bin/mise run test src/bot/database/db.test.ts` — expect FAIL (no 0005).
- [ ] **Step 3: Edit the schema files** as in Interfaces, then `./bin/mise run db:generate`.
      Drizzle rebuilds `cards` and `wanted_cards` (`__new_…` copy). Edit the generated SQL so every
      `INSERT INTO "__new_…" SELECT` writes `'lego-minecraft-3'` for `collection`, and the
      `ALTER TABLE listings ADD collection … NOT NULL` carries `DEFAULT 'lego-minecraft-3'` (SQLite
      needs a default to add a NOT NULL column); add a leading SQL comment saying the backfill is
      hand-edited, as 0003 does.
- [ ] **Step 4: Run** `./bin/mise run test src/bot/database/db.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `feat(database): key cards, wanted cards and listings by collection`.

### Task 3: Catalog and user managers take the collection

**Files:**

- Modify: `src/bot/database/catalogManager.ts`, `src/bot/database/userManager.ts`,
  `src/bot/cards/starterCatalog.ts` (no logic change; the starter list belongs to
  `lego-minecraft-3`)
- Test: `src/bot/database/catalogManager.test.ts`, `src/bot/database/userManager.test.ts`

**Interfaces:**

- Consumes: `CollectionId`, `COLLECTIONS` (Task 1); schema (Task 2).
- Produces (every card-touching function gains `collection: CollectionId` as its first
  parameter after any `discordId`):
  - `parseKnownCardList(collection, input, { checkCatalog })`
  - `catalogManager.seedIfEmpty()` seeds `lego-minecraft-3` from `STARTER_CHECKLIST` when that
    collection has no card (per collection, not per table);
    `knownIds(collection)`, `cardNames(collection)`, `getCard(collection, id)`,
    `referenceCatalog(collection)` (shared-picture detection within the collection only),
    `updateNamesAndReferences(collection, entries)`, `previewImport(collection, ids)`,
    `applyImport(collection, ids)`. `CatalogCard` gains `collection`.
  - `userManager.setList(discordId, collection, input)`, `addToList`, `removeFromList`,
    `clearList(discordId, collection)`, `getList(discordId, collection)`,
    `allWantedIds(): Map<CollectionId, Set<CardId>>`,
    `usersWanting(collection, cardIds): Map<string, CardId[]>`.

- [ ] **Step 1: Write the failing tests** (adapt every existing call; add):
      `seedIfEmpty()` twice leaves 251 cards in `lego-minecraft-3`; `allWantedIds()` returns `Map { 'lego-minecraft-3' => Set {'12','LE8'} }`
      after `setList('u1','lego-minecraft-3','12, LE8')`; `clearList('u1','lego-minecraft-3')` empties
      only that collection's list.
- [ ] **Step 2: Run** `./bin/mise run test src/bot/database` — expect FAIL (signatures).
- [ ] **Step 3: Implement** the signatures; every query on `cards`/`wanted_cards` filters by
      `collection`.
- [ ] **Step 4: Run** `./bin/mise run test src/bot/database` and `./bin/mise run typecheck`
      (typecheck fails in callers; fixed in Tasks 4-7 — run only the database tests green here).
- [ ] **Step 5: Commit** `refactor(database): read catalog and wanted lists per collection`.

### Task 4: Listing manager, adapters and runner per collection

**Files:**

- Modify: `src/bot/database/listingManager.ts`, `src/bot/shops/types.ts`,
  `src/bot/shops/adapters.ts`, `src/bot/check/runner.ts`, `src/bot/bot.ts`, `src/test/listings.ts`
- Test: `listingManager.test.ts`, `adapters.test.ts`, `runner.test.ts`

**Interfaces:**

- Consumes: Tasks 1-3.
- Produces:
  - `StoredListing.collection: CollectionId`; `storedListing(shop, cards, over?)` defaults it to
    `'lego-minecraft-3'`.
  - `ShopAdapter` gains `readonly collection: CollectionId`; `createShopAdapters(ebay,
cardNames: (collection: CollectionId) => ReadonlyMap<CardId, string>)` builds the existing
    four adapters with `collection: 'lego-minecraft-3'` (eBay receives
    `() => cardNames('lego-minecraft-3')`).
  - `listingManager.upsertFromRun(shop, collection, found, now)`: unavailable marking and
    upserts only for rows of that (shop, collection); a found URL stored under another collection
    keeps its row and collection (first claimer wins, spec).
  - `rematchMismatches(collection, cardIds)`, `listingsForCards(collection, cardIds)`,
    `overrideCards(url, collection, cardIds, now)` (sets the listing's collection too; the
    override flag keeps both on rescrape), `pendingNotifications` uses
    `usersWanting(listing.collection, …)`.
  - Runner: `checkShop` passes `adapter.collection`; sammel-ente's
    `updateNamesAndReferences(adapter.collection, …)`; `matchPending` keeps one lazily loaded
    `ReferenceCatalog` and reference set per collection (`Map<CollectionId, …>`) and filters with
    `wanted.get(listing.collection)`; the empty-wanted short cut checks every collection's set.
    `RunSummary` is unchanged in this PR (one collection).
  - `bot.ts`: `createShopAdapters(config.ebay, (c) => catalogManager.cardNames(c))`.

- [ ] **Step 1: Write the failing tests** (adapt existing; add): a stored eBay listing stays
      available after a sammel-ente run that did not return it (existing behaviour, keep);
      `upsertFromRun` returns listings with `collection: 'lego-minecraft-3'`; `overrideCards`
      returns the listing with `collection: 'lego-minecraft-3'` and a rescrape keeps cards and
      collection; `adapters.test.ts`: every adapter has `collection === 'lego-minecraft-3'`; the
      `cardNames` callback is called with `'lego-minecraft-3'` when eBay fetches.
- [ ] **Step 2: Run** `./bin/mise run test src/bot/database src/bot/shops src/bot/check` — FAIL.
- [ ] **Step 3: Implement** the Interfaces.
- [ ] **Step 4: Run** the same tests — PASS.
- [ ] **Step 5: Commit** `refactor(bot): carry the collection through listings, shops and runs`.

### Task 5: Matcher and notifications read references per collection

**Files:**

- Modify: `src/bot/notify/messages.ts`, `src/bot/interactions/report.ts`
- Test: `messages.test.ts`, `report.test.ts`

**Interfaces:**

- Consumes: Tasks 3-4.
- Produces: `buildNotificationMessages` builds references with
  `catalogManager.referenceCatalog(item.listing.collection)` (cached per collection within one
  call) and names via `getCard(listing.collection, id)`; the admin report message reads
  `getCard(listing.collection, …)` and suggests
  `/admin map url:… collection:<listing.collection> cards:<ids>`. Message text otherwise
  unchanged (collection names in alerts come in PR 3).

- [ ] **Step 1: Write the failing test**: the admin report text contains
      `collection:lego-minecraft-3`; existing message snapshots unchanged.
- [ ] **Step 2: Run** `./bin/mise run test src/bot/notify src/bot/interactions` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `refactor(notify): read card names and references per collection`.

### Task 6: Commands take a collection option

**Files:**

- Create: `src/bot/commands/collectionOption.ts`, `collectionOption.test.ts`
- Modify: `missing.ts`, `stock.ts`, `stockPage.ts`, `card.ts`, `admin.ts`, `help.ts`,
  `src/bot/interactions/catalogImport.ts`
- Test: the matching `*.test.ts`

**Interfaces:**

- Consumes: `collectionChoices`, `isCollectionId`, `collectionById` (Task 1); managers.
- Produces:
  - `addCollectionOption<T extends { addStringOption: … }>(builder: T): T` adds option
    `collection`, required, choices `collectionChoices()`, description
    `Card collection`.
  - `readCollection(i: ChatInputCommandInteraction): CollectionId | null` (null for a value not
    in the registry; the caller replies ephemerally `Unknown collection.` and stops).
  - `/missing set|add|remove|list|clear|status`, `/stock`, `/card`, `/admin map`,
    `/admin catalog import` gain the option (placed first among options; Discord requires
    required options before optional ones).
  - Stock buttons: `stockCustomId(collection, page, filter)` → `stock:<collection>:<page>:<filter>`;
    `parseStockCustomId` also accepts the legacy `stock:<page>:<filter>` as `DEFAULT_COLLECTION`.
  - `ImportStore.put(collection, ids)`, `take(token): { collection; ids } | undefined`.
  - `/help` mentions `collection:` in each command's example.

- [ ] **Step 1: Write the failing tests**: each command's builder JSON has `collection` as a
      required string option with one choice `lego-minecraft-3`; `readCollection` returns null for
      `'lego-minecraft-9'` and the command replies `Unknown collection.` ephemerally without touching
      the database; `parseStockCustomId('stock:2:missing')` returns
      `{ collection: 'lego-minecraft-3', page: 2, filter: 'missing' }` and
      `parseStockCustomId('stock:lego-minecraft-3:2:missing')` the same; `/admin map` with the option
      calls `overrideCards(url, 'lego-minecraft-3', …)`.
- [ ] **Step 2: Run** `./bin/mise run test src/bot/commands src/bot/interactions` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `./bin/mise run test`, `./bin/mise run typecheck`, `./bin/mise run lint`,
      `./bin/mise run format:check` — all pass.
- [ ] **Step 5: Commit** `feat(commands): choose the collection in every card command`.

### Task 7: Docs, review, PR

**Files:**

- Modify: `CLAUDE.md` (Architecture: add `collections/`; Invariants: "Every card, wanted entry
  and listing belongs to a collection (`collections/`); ids are unique per collection"),
  `docs/development.md` (where collections live), `docs/configuration.md` only if commands are
  documented there.

- [ ] **Step 1:** Update the docs as listed; `./bin/mise run format:check`.
- [ ] **Step 2:** Commit `docs: describe collections`.
- [ ] **Step 3:** Push, open the PR (`feat: key everything by collection`), run
      `/pr-review-toolkit:review-pr` with code, tests, errors, comments, types; fix every finding;
      re-run after substantial fixes.
- [ ] **Step 4:** Hand over for labels and merge; after deploy, `/admin run` and check
      `/missing status collection:…` for an existing user shows the same list as before.
