# Collections PR 3b: eBay across collections — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One eBay run serves every LEGO Minecraft collection. Each title is placed in the collection whose series marker it names, and series 3's name check refuses a name that series 1 or 2 has at the same number.

**Architecture:**

- Each collection's definition names its eBay queries and its series marker.
- The eBay fetcher runs every collection's queries once, classifies each title by marker (exactly one collection, else excluded), and returns listings tagged with their collection.
- The runner stores the eBay result per collection, including collections with no listings (their gone listings are marked unavailable as today).
- An unmapped eBay listing whose title now names another collection moves there.
- eBay keeps one alert key, `shop-error:ebay`.

**Tech Stack:** Bun, TypeScript, Drizzle on SQLite.

**Spec:** `docs/superpowers/specs/2026-11-19-multi-collection-design.md`. Read these sections: "eBay", "Commands" (moving a listing), "Notes from PR 1 / 3a".

## Facts (live probe 2026-11-24, bot credentials, queries `lego minecraft karten serie 1`, `… serie 2`, `lego minecraft tcc serie 1`, `lego minecraft boom bastic karte`)

536 items in total.

**Series 1 titles are uniform.** Example: `LEGO Minecraft Serie 1 Trading Card 134 - Neon Lohe - Mob Karte - Neon`.

- The number follows `Trading Card`, so the existing `Card N` prefix form reads it.
- The type is the laststicker section (`Mob Karte`, `Skin Karte`, `Tierkarte`, `Comic Karte`).
- The trailing `- Neon` / `- Holo` / `- Ultra` is the card's variant, not a parallel. Series 1 #134 is "Neon Lohe", and every Neon card has its own number.

**Series 2 titles:**

- Most are category lots without a number: `Lego Minecraft Sammelkarten Serie 2"NETHER"`, which gives no id.
- A few read `Blue Ocean LEGO Minecraft 2025 Sammelkarte 216 Trading Cards Boom-Bastic TNT`. `Sammelkarte N` is no title form today, so it gives no id. That is acceptable: no wrong id, and few listings.

**Markers seen:**

| Marker                        | Titles  |
| ----------------------------- | ------- |
| `Serie 1`                     | 269     |
| `Serie 2`                     | 205     |
| `Series 1`                    | 1       |
| `Boom-Bastic` / `Boom Bastic` | several |

## Global Constraints

- All tasks run through `./bin/mise run <task>`. Every non-test source file has a `*.test.ts`.
- Commits:
  - Conventional Commits (scopes `ebay`, `shops`, `database`, `docs`), `git commit -s`.
  - Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never use `--no-verify`.
- Never log `EBAY_CLIENT_SECRET` or eBay access tokens. The fixture has no seller data (as `ebay-search.json`).
- eBay rules stay as today: offsets, page cap and truncation alert, walk tolerance, `COUNT_WORDS`, pick lists, ranges, variations. Any failing or malformed search fails the whole eBay run, so no collection's eBay listings are touched.
- Anti-goal (spec): a card of another collection must never be alerted. When unsure, give no id.
- No series 3 regression. The existing `ebay.test.ts` cases keep their ids; series 1 and 2 titles still give no series 3 id.

## Review Focus

1. **A series 1 title** gives series 1 ids only, never series 3 ones. The same URL, once stored as series 3, moves to series 1 on the next run unless the admin mapped it. Pinned in Tasks 2 and 4.
2. **A title naming two series** (`Serie 1 und Serie 3 Lot`) gives no ids (`several collections`). Pinned in Task 2.
3. **A failing eBay search** leaves the eBay listings of every collection untouched and raises one `shop-error:ebay` alert. Pinned in Task 4.
4. **A collection with no eBay listing in a successful run** gets its gone listings marked unavailable, exactly as one collection did before. Pinned in Task 4.
5. **`Karte 104 - Ghast`** without a series word is series 3 #104 only if series 1 and 2 have no "Ghast" at #104. If either has, it gives no id. Pinned in Task 3.

---

### Task 1: Fixture of series 1 and 2 searches

**Files:**

- Create: `src/test/fixtures/ebay-search-series-1-2.json`
- Modify: `scripts/` (a one-off capture is fine inside the scratchpad, not committed)

- [ ] **Step 1: Capture.**
  - Run `createEbayFetcher` with a `fetchFn` that records every search answer, with `EBAY_QUERIES` replaced by the four queries above.
  - Keep 40 items, covering:
    - series 1 singles of each type (Skin, Mob, Tier, Comic);
    - a series 1 pack and a pick list;
    - series 2 category lots;
    - the `Sammelkarte N … Boom-Bastic` form;
    - a title naming two series;
    - a title naming none.
  - Strip the seller fields the way `ebay-search.json` was stripped (`seller`, `itemLocation`, the user ids). Keep `itemId`, `title`, `itemWebUrl`, `price`, `buyingOptions`, `image`, `itemGroupType`.
- [ ] **Step 2: Commit** `test(ebay): add a fixture of series 1 and 2 searches`.

### Task 2: Series markers and per-collection queries

**Files:**

- Modify: `src/bot/collections/ids.ts`, the three definitions (+ tests)
- Modify: `src/bot/shops/ebay.ts`, `ebay.test.ts`

**Interfaces:**

- Produces:
  - `CollectionShops.ebay?: { readonly queries: readonly string[]; readonly series: RegExp }`.
    - Series 1: queries `lego minecraft karten serie 1`, `lego minecraft tcc serie 1`; series `/\bSeries?\s*1\b|\bTCC\s*1\b/i`.
    - Series 2: queries `lego minecraft karten serie 2`, `lego minecraft boom bastic karte`; series `/\bSeries?\s*2\b|\bBoom[-\s]?Bastic\b/i`.
    - Series 3: today's `EBAY_QUERIES` and `SERIES_3_PATTERN`.
    - `checkSettings` (adapters.ts) now allows `ebay` on every collection.
  - `classifyTitle(title, markers: readonly { id: CollectionId; series: RegExp }[]): { collection: CollectionId } | { exclusion: 'several collections' | 'no collection' }`.
    - Exactly one marker matching gives that collection.
    - `titleExclusion(title)` keeps the pick-list, range and variation rules; its `other series` / `no series 3` cases become `several collections` / `no collection`.
    - `SERIES_1_2_PATTERN` goes.
  - `extractCardIdsFromTitle(title)` reads the ids of a classified title with the existing title forms. Every collection keeps today's canonical id rule.
  - `isPictureCandidate` and the name check apply only to `lego-minecraft-3` (as today).
- [ ] **Step 1: Failing tests** in `ebay.test.ts`:
  - `a series 1 title belongs to series 1`: `LEGO Minecraft Serie 1 Trading Card 134 - Neon Lohe - Mob Karte - Neon` gives `{ collection: 'lego-minecraft-1' }`, ids `['134']`.
  - `Boom-Bastic names series 2`.
  - `a title naming two series is excluded` (Review Focus 2): `Lego Minecraft Karten Serie 1 und Serie 3 Lot` gives `several collections`.
  - `a title naming no series is "no collection"`, and goes on to the series 3 name check as today.
  - The existing tests stay. Rename their expected `other series` to `several collections` where the title also names series 3, and to the right collection where it names only series 1 or 2.
  - Fixture test: every item of `ebay-search-series-1-2.json` gets a collection and ids. Record the expected ids table in the test, reviewed by hand once.
- [ ] **Step 2: Run.** `./bin/mise run test src/bot/shops/ebay.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the Produces list.
- [ ] **Step 4: Run** `./bin/mise run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ebay): place each title in the collection whose series it names`

### Task 3: The name rule across series

**Files:**

- Modify: `src/bot/shops/ebay.ts` (`nameMatchedCardIds`), `ebay.test.ts`, `docs/shops.md`.

**Interfaces:**

- Produces: `nameMatchedCardIds(title, names, otherSeriesNames: readonly ReadonlyMap<CardId, string>[])`. A number counts only when no other series' catalog has the same name, compared as today (case, umlauts, punctuation), at that number.
- The fetcher passes series 1's and 2's `cardNames` (read at the start of the fetch) as `otherSeriesNames`.
- [ ] **Step 1: Failing tests** (Review Focus 5):
  - `a series 3 name another series has at that number gives no id`: names `{104: 'Ghast'}`, other `{104: 'Ghast'}`, so `Karte 104 - Ghast` gives `[]`.
  - `a name only series 3 has at that number still counts`: other `{104: 'Blaze'}` gives `['104']`.
  - `an empty other catalog (not synced yet) changes nothing`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Update the `nameMatchedCardIds` doc, CLAUDE.md's eBay decision (the `Karte 104 - Ghast` sentence), and `docs/shops.md`.
- [ ] **Step 4: Run** `./bin/mise run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ebay): read a series 3 name only where no other series has it`

### Task 4: One eBay run, stored per collection

**Files:**

- Modify: `src/bot/shops/types.ts` (`Listing.collection?`), `ebay.ts`, `adapters.ts`, `src/bot/check/runner.ts`, `src/bot/database/listingManager.ts` (+ tests).

**Interfaces:**

- Produces:
  - `Listing.collection?: CollectionId`. Set by eBay; the runner stores a listing in it.
  - `ShopAdapter.collections?: readonly CollectionId[]`. The collections an adapter's run covers; default `[collection]`.
  - `createShopAdapters` builds one eBay adapter for every collection with `shops.ebay`, with `collection: LEGACY_COLLECTION` and `collections` = those ids.
  - `runner.checkShop` for an adapter with `collections`:
    - It groups the result by `listing.collection`.
    - It calls `upsertFromRun(shop, c, group, now, { moveFrom: true })` for every covered collection, including those with an empty group.
    - It records a summary entry per collection.
    - On a fetch error it records the error for every covered collection and sends one alert with key `shop-error:ebay`.
  - `upsertFromRun(..., { moveFrom?: boolean })`: with `moveFrom`, a URL stored under another collection and not `manualOverride` moves:
    - its collection and cards become the title's;
    - its status becomes `pending`, as for a changed title;
    - `rematchFrom` is cleared.
    - An admin-mapped one stays where it is (foreign, as today).
- [ ] **Step 1: Failing tests:**
  - `listingManager.test.ts`:
    - `an eBay listing whose title names another collection moves there` (Review Focus 1).
    - `an admin-mapped one stays`.
  - `runner.test.ts`:
    - `one eBay run stores each collection's listings and marks each collection's gone ones` (Review Focus 4).
    - `a failing eBay run touches no collection and alerts once` (Review Focus 3).
  - `adapters.test.ts`: `one eBay adapter covers every collection with eBay settings`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the Produces list. The `foreign` alert stays for the other shops. eBay never raises it, as it moves instead.
- [ ] **Step 4: Run** `./bin/mise run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(ebay): one eBay run for every collection`

### Task 5: Docs

- [ ] **Step 1: Update the docs**
  - CLAUDE.md:
    - The eBay decision reads markers per collection.
    - "the series-1/2 exclusion" becomes the exactly-one-collection rule.
    - The name rule.
    - Moving between collections.
    - The `shop-error:ebay` key.
  - `docs/shops.md`: the probe numbers, the series 1 title form, and the series 2 forms that give no id.
  - The spec's "Notes from PR 3b".
- [ ] **Step 2: Check.** Run `./bin/mise run format:check`. Expected: clean.
- [ ] **Step 3: Commit** `docs: describe eBay across collections`
