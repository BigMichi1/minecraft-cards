# Collections PR 3a: LEGO Minecraft series 1 and 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `lego-minecraft-1` and `lego-minecraft-2`:

- catalogs synced from laststicker;
- listings from sammel-ente (series 1 and 2) and collect-it (series 1);
- run results, peaks and alerts keyed per (shop, collection).

**Architecture:**

- Each `CollectionDefinition` names its laststicker set (with options) and its shop settings.
- `adapters.ts` builds one adapter per (collection, shop).
- The sammel-ente and collect-it fetchers take their category settings. Fetchers of one shop share one paced fetch, so 1500 ms holds across collections.
- `RunSummary` gains a per-collection shop map; S3 rows stored before it are still read.

**Out of scope (own PRs):**

- 3b: eBay across collections (series markers, moving a listing between collections, the name-rule change for `Karte 104 - Ghast`).
- 3c: blue-ocean's new TCC categories (`Nummer 250 I Schildkröte I LEGO Minecraft TCC 1`, product id in the URL, a new parser).

**Tech Stack:** Bun, TypeScript, Drizzle on SQLite, cheerio, discord.js.

**Spec:** `docs/superpowers/specs/2026-11-19-multi-collection-design.md`. Read these sections: "Collection registry", "Catalog from laststicker", "Shops per collection", "Commands", "Rollout in steps" (step 3), and the "Notes from PR 1 / 2a / 2b".

## Facts measured 2026-11-24 (bot User-Agent, 1500 ms pacing)

**laststicker** (`/de/cards/<set>/`):

| Set                                         | Collection | Set id | Rows | Names                             | Sections                                                                                                                                        | Scans                                                           |
| ------------------------------------------- | ---------- | ------ | ---- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `blue_ocean_lego_minecraft-1`               | series 1   | 10289  | 283  | German (`Explodierender Creeper`) | Skin Karte 81, Mob Karte 72, Puzzlekarte 27, Comic Karte 36, Tierkarte 34, Platin Karte 4, Limited Edition 27, Oversize Karte 2                 | `1.jpg`, `le1.jpg`, `xxl1.jpg` load                             |
| `blue_ocean_lego_minecraft_tnt_boom_bastic` | series 2   | 12126  | 297  | English                           | Oberwelt 90, Nether 56, End 24, Setkarten 16, Crafting-Karten 21, Puzzlekarten 27, Comic-Karten 32, Smaragdkarten 10, Limited Edition 20, `-` 1 | none at all (`1.jpg`, `le1.jpg`, `xxl.jpg`, `xxl1.jpg` all 404) |

- Series 1 ids: LE1–LE27, XXL1, XXL2. Its puzzle section is `Puzzlekarte`; series 3's is `Puzzlekarten`.
- Series 2's last row is a bare `XXL` ("Ghast", section `-`), which today's parser rejects ("no card number XXL"); its LE cards run LE1–LE20.
- `blue_ocean_lego_minecraft` (set 11073) is the sticker album, not cards.

**sammel-ente:**

- `/Minecraft/Serie-1/` and `/Minecraft/Serie-2/`: 13 pages each. Titles `LEGO Minecraft Serie 1 | #001 Steve`, `#LE008`, `#XXL001`; series 2 likewise (`#XXL001 Ghast`).
- Today's parser reads both unchanged.
- Series 2 also sells LE21 "Chicken Jockey" and LE22 "Enderman", which laststicker lacks (manual cards for the admin).

**collect-it:**

- `/sammelwelt/sammelkarten/lego/minecraft/serie1/Einzelkarten` parses with today's parser (`1 - Steve - Skin Karte - Serie 1`, 30 per page, canonical link as expected).
- There is no series 2 single-card category (`serie-2` answers 404).

**blue-ocean:** the TCC categories need a new parser (PR 3c). Series 3 keeps today's category.

## Global Constraints

- All tasks run through `./bin/mise run <task>`. Every non-test source file in `src/` has a `*.test.ts`.
- Commits:
  - Conventional Commits (scopes `cards`, `shops`, `database`, `commands`, `docs`), `git commit -s`.
  - End every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never use `--no-verify`.
- Collection ids are never renamed or removed: `lego-minecraft-1`, `lego-minecraft-2`.
- Shop requests: User-Agent `minecraft-cards-bot/1.0 (+hourly stock check)`, 20 s timeout, 1500 ms between page requests of one shop, also across collections.
- A shop error (fetch throws, `ShopLayoutError`) leaves only that (shop, collection)'s stored listings untouched and alerts with a key naming both.
- Card ids stay canonical (`12`, `LE8`, `XXL1`); there is no new id rule in this PR.
- Anti-goal: no series 3 regression. Every existing test passes, adapted only for the per-collection keys.

## Review Focus

1. **Stored runs from before this PR.** Rows with `shops` only must still feed `/missing status`, `/stock`, `/card` and the drop check for series 3. Pinned in Task 4.
2. **Pacing across collections.** sammel-ente series 1, then series 2, then series 3 in one run: the first request of the next collection waits 1500 ms after the last page of the previous one. Pinned in Task 3.
3. **A failing shop for one collection.** A failing sammel-ente series 1 fetch leaves series 1 untouched, does not mark sammel-ente series 3 listings unavailable, and alerts `shop-error:sammel-ente:lego-minecraft-1`. Pinned in Task 4.
4. **A wrong-series item in collect-it.** An item whose title ends `- Serie 3` in the series 1 category is skipped and counted (`skippedExcluded`); it is never stored as a series 1 card. Pinned in Task 3.
5. **A laststicker number the alias does not cover.** For series 2, a bare `XXL` row becomes `XXL1`; any other unreadable number is still a `CatalogLayoutError` naming it, and nothing changes. Pinned in Task 1.

---

### Task 1: Definitions and catalogs for series 1 and 2

**Files:**

- Create: `src/bot/collections/legoMinecraft1.ts` (+ test)
- Create: `src/bot/collections/legoMinecraft2.ts` (+ test)
- Modify: `src/bot/collections/ids.ts`, `index.ts` (+ tests)
- Modify: `src/bot/catalog/laststicker.ts`, `sync.ts` (+ tests)
- Modify: `src/bot/database/catalogManager.ts` (+ test)
- Fixtures: `src/test/fixtures/laststicker-lego-minecraft-1.html`, `laststicker-lego-minecraft-2.html`. Fetch each once with the bot's `fetchText`; trim to the checklist table and the `cards_tooltip` element, keeping every row.

**Interfaces:**

- Produces:
  - `COLLECTION_IDS = ['lego-minecraft-1', 'lego-minecraft-2', 'lego-minecraft-3'] as const`, in display order. Ids are stored and never renamed.
  - `CollectionDefinition.laststicker?: { set: string; scans?: false; numberAliases?: Readonly<Record<string, string>> }`.
    - `scans: false`: laststicker has no scans for the set. The sync stores no scan URL (`laststickerImageUrl` null), so the shop picture is the reference from the start and nobody fetches 297 dead URLs.
    - `numberAliases`: a raw checklist number mapped to the canonical id before `normalize` (`{ XXL: 'XXL1' }`).
  - `legoMinecraft1`:
    - `name: 'LEGO Minecraft Serie 1'`
    - `laststicker: { set: 'blue_ocean_lego_minecraft-1' }`
    - `referenceFallbackShop: 'sammel-ente'`
    - no starter checklist
    - `knownTwins` left out until Task 2 measures it
  - `legoMinecraft2`:
    - `name: 'LEGO Minecraft Serie 2 "TNT Boom-Bastic"'`
    - `laststicker: { set: 'blue_ocean_lego_minecraft_tnt_boom_bastic', scans: false, numberAliases: { XXL: 'XXL1' } }`
    - `referenceFallbackShop: 'sammel-ente'`
  - `LaststickerRow.pictureUrl: string | null`.
  - `fetchLaststickerSet(set, options?: { scans?: false; numberAliases? })`; `parseLaststickerPage` takes the same options.
  - A puzzle card is a row whose section starts with `Puzzlekarte`, which covers series 1's `Puzzlekarte` and series 3's `Puzzlekarten`, or a row with a piece marker. This replaces `PUZZLE_KIND`.
- Consumes: `syncCatalogs` already iterates `COLLECTIONS` with a laststicker set.

- [ ] **Step 1: Failing tests**
  - `laststicker.test.ts`:
    - `the series 1 page parses: 283 cards, German names, Puzzlekarte puzzle cards` (fixture). Expect 27 puzzle rows, ids `LE27`, `XXL2`, and the scan of `XXL1` `…/i/cards/10289/xxl1.jpg`.
    - `the series 2 page parses with its XXL alias and without scans`. Expect 297 rows, the last one `{ cardId: 'XXL1', name: 'Ghast' }`, and every `pictureUrl` null.
    - `a bare number no alias covers is still a CatalogLayoutError` (Review Focus 5). A series 2 fixture with the alias left out throws `no card number "XXL"`.
  - `catalogManager.test.ts`: `syncCollection marks Puzzlekarte and Puzzlekarten rows as puzzle cards`.
  - `index.test.ts`:
    - `the registry lists series 1, 2 and 3 in order`.
    - The existing tests: ids unique and slug-shaped, choices, starter checklist only for series 3.
  - The definition tests: `toEqual` on each literal.
- [ ] **Step 2: Run.** `./bin/mise run test src/bot/catalog src/bot/collections src/bot/database/catalogManager.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the Produces list:
  - `sync.ts` passes `definition.laststicker` to `fetchLaststickerSet`.
  - `syncCollection` stores `laststickerImageUrl: row.pictureUrl`; null for series 2.
  - `seedIfEmpty` seeds only collections with a starter checklist, as today.
- [ ] **Step 4: Run** `./bin/mise run typecheck` and `./bin/mise run test`. Expected: PASS. Adapt only tests that pin `COLLECTION_IDS` or the choice list.
- [ ] **Step 5: Commit** `feat(cards): add LEGO Minecraft series 1 and 2 with their laststicker catalogs`

### Task 2: Measure series 1 scans (go/no-go for its scans)

**Files:**

- Modify: `scripts/measure-laststicker.ts`, to take `--collection <id>` (default `lego-minecraft-3`); the set and the sammel-ente category come from the definition.
- Modify: `docs/image-matching.md`, adding a series 1 block to the laststicker measurement section.
- Maybe modify: `src/bot/collections/legoMinecraft1.ts` (`knownTwins`, or `scans: false`).

- [ ] **Step 1: Make the script read the definition:** the set, `scans`, the fallback shop's category URL (Task 3 settings, or the literal `/Minecraft/Serie-1/` until then), and `knownTwins`. Same output as for series 3.
- [ ] **Step 2: Run** `./bin/mise run measure:laststicker -- --collection lego-minecraft-1`.
      Expected: sammel-ente and collect-it blocks, an identification block and a twin list. It takes about 10 minutes.
- [ ] **Step 3: Decide**, by the series 3 rule (wrong pairs at 0.78 within the 3–5 % accepted before, no wrong decision):
  - **Keep the scans** if both hold.
  - **Add known twins** for every pair the identification decides wrongly between same-art cards (as #59/XXL1).
  - **Set `scans: false`** if the wrong-pair rate is worse than 5 % or decisions go wrong for other reasons. sammel-ente's pictures then serve as for series 2.
  - Record the numbers and the decision.
- [ ] **Step 4: Commit** `docs(matcher): measure the series 1 laststicker scans`

### Task 3: Shop settings per collection, and one pacer per shop

**Files:**

- Modify: `src/bot/collections/ids.ts` (shop settings types), the three definition files.
- Modify: `src/bot/shops/sammelEnte.ts`, `collectIt.ts`, `adapters.ts` (+ tests).
- Fixtures:
  - `src/test/fixtures/sammel-ente-serie-1-p1.html`, `sammel-ente-serie-1-p12.html` (with LE and XXL);
  - `src/test/fixtures/collect-it-serie-1-p1.html`.
  - Trim each like the existing ones.

**Interfaces:**

- Produces:
  - `CollectionDefinition.shops: CollectionShops`, with:
    ```ts
    interface CollectionShops {
      readonly 'sammel-ente'?: { readonly category: string }; // absolute category URL
      readonly 'collect-it'?: { readonly category: string; readonly series: string }; // `Serie 1`
      readonly 'blue-ocean'?: Record<string, never>; // series 3 only, today's category
      readonly ebay?: Record<string, never>; // series 3 only until PR 3b
    }
    ```
  - Values:
    - series 1: sammel-ente `https://shop-sammel-ente.de/Minecraft/Serie-1/`, collect-it `https://www.collect-it.de/sammelwelt/sammelkarten/lego/minecraft/serie1/Einzelkarten` with series `Serie 1`.
    - series 2: sammel-ente `…/Serie-2/`.
    - series 3: sammel-ente `…/Serie-3/`, collect-it today's URL with series `Serie 3`, `blue-ocean: {}`, `ebay: {}`.
  - `createSammelEnteFetcher(settings: { category: string }, fetchFn?, options?)`.
  - `createCollectItFetcher(settings: { category: string; series: string }, fetchFn?, options?)`:
    - Every helper that used the module constant `BASE_URL` (`categoryPageNumber`, the canonical and next checks) takes the category.
    - A title whose last `-` part is a series label other than `settings.series` (`/^Serie \d+$/`) is skipped and counted in `skippedExcluded`.
    - `TITLE_PATTERN` also reads `XXL 1 - …` (an optional space after `LE`/`XXL`).
  - `createShopAdapters(ebay, cardNames)` returns one adapter per (collection in `COLLECTIONS` order, shop in `SHOP_IDS` order) that the definition lists. eBay is listed only when credentials are set.
  - All fetchers of one shop get one `createPacedFetch(fetch, new Set([<that shop's host>]), 1500)` as their `fetchFn`. `checkOneAdapterPerShop` becomes `checkOneAdapterPerShopAndCollection`.

- [ ] **Step 1: Failing tests**
  - `sammelEnte.test.ts`: `the series 1 category is read from its settings`. The fixture gives `1`, `LE8`, `XXL1` and requests `…/Serie-1/?p=1`.
  - `collectIt.test.ts`:
    - `the series 1 category walks its own pages`.
    - `an item of another series in the category is skipped and counted` (Review Focus 4): `5 - Creeper - Charakterkarte - Serie 3` in the series 1 settings gives `skippedExcluded: 1`.
    - `"XXL 1 - …" reads as XXL1`.
  - `adapters.test.ts`:
    - `one adapter per collection and shop, in collection then shop order`. Expect `[sammel-ente:1, collect-it:1, sammel-ente:2, sammel-ente:3, blue-ocean:3, collect-it:3, ebay:3]`, with eBay only when configured.
    - `fetchers of one shop share one pacer` (Review Focus 2): with a fake clock and fake fetch, two sammel-ente adapters fetched back to back give a sleep of 1500 between the last request of the first and the first of the second.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the Produces list. `bot.ts` wiring is unchanged apart from `createShopAdapters`.
- [ ] **Step 4: Run** `./bin/mise run test`. Expected: PASS. Existing tests adapt to the settings parameter only.
- [ ] **Step 5: Commit** `feat(shops): read sammel-ente and collect-it per collection, paced per shop`

### Task 4: Run results, peaks and alerts per (shop, collection)

**Files:**

- Modify: `src/bot/check/runner.ts`, `src/bot/database/runManager.ts`, `src/bot/commands/admin.ts` (`formatSummary`) (+ tests).

**Interfaces:**

- Produces:
  - `RunSummary.collections?: Partial<Record<CollectionId, Partial<Record<ShopId, ShopSummary>>>>`. New runs write every result there, and write `shops: {}`, which every version reads.
  - `export function shopEntry(summary: RunSummary, collection: CollectionId, shop: ShopId): ShopSummary | undefined` in `runManager.ts`. It answers from `collections`, or, for a row without `collections` and `collection === LEGACY_COLLECTION`, from `shops`.
  - `runManager.shopPeakListings(shop, collection, now)` uses `shopEntry`.
  - Alert keys: `shop-error:<shop>:<collection>`, `shop-drop:<shop>:<collection>`, `shop-all-unavailable:<shop>:<collection>`, `shop-truncated:<shop>:<collection>`, `shop-rematch:<collection>:<cards>` (unchanged). Alert texts name the collection: `Shop sammel-ente (LEGO Minecraft Serie 1) check failed: …`.
  - `formatSummary` prints one block per collection: `<collection name>:` then the shop lines, as today.
- Consumes: Task 3's adapters.

- [ ] **Step 1: Failing tests**
  - `runManager.test.ts`:
    - `shopEntry reads the per-collection map, and an old row's shops for series 3 only` (Review Focus 1).
    - `the peak is per shop and collection`.
  - `runner.test.ts`:
    - `a failing shop for one collection leaves the other collections' listings alone` (Review Focus 3). sammel-ente series 1 throws while series 3 succeeds. The series 3 listings stay available, the series 1 listings untouched, and there is one alert with key `shop-error:sammel-ente:lego-minecraft-1`.
    - `the summary holds each collection's shops`.
  - `admin.test.ts`: `formatSummary prints a block per collection`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the Produces list. Every reader of `summary.shops[...]` goes through `shopEntry`: `shopCell.ts` `succeeded`/`needsLastSuccess`, `missingStatus.ts`, `missing.ts`, `stock.ts`, `card.ts`. They take the command's collection.
- [ ] **Step 4: Run** `./bin/mise run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(bot): key run results and shop alerts per shop and collection`

### Task 5: Enabled shops per collection in the commands

**Files:**

- Modify: `src/bot/bot.ts` (wiring), `src/bot/commands/shopCell.ts`, `missing.ts`, `missingStatus.ts`, `stock.ts`, `card.ts`, `cardReply.ts` (+ tests).

**Interfaces:**

- Produces: `enabledShops: ReadonlyMap<CollectionId, readonly ShopId[]>`, built in `bot.ts` from the adapters. A shop not in a collection's list shows as `not enabled` there. For series 2 that is collect-it, blue-ocean and eBay.
- Consumes: Task 4's `shopEntry`.

- [ ] **Step 1: Failing tests**
  - `missingStatus.test.ts`: `a shop the collection does not use is "not enabled" there`. Series 2 shows collect-it as not enabled while series 3 shows it checked.
  - `shopCell.test.ts`: `shopCells reads enabled shops per collection`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Change `enabledShops` from a list to the map in every command context.
- [ ] **Step 4: Run** `./bin/mise run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(commands): show each collection's own shops`

### Task 6: Docs

- [ ] **Step 1: Update the docs**
  - `CLAUDE.md`:
    - Architecture: `collections/` holds series 1, 2 and 3.
    - Invariant: shop requests are paced per shop across collections.
    - Decisions:
      - sammel-ente and collect-it are read per collection from the definition;
      - collect-it skips other series' items;
      - series 2 has no laststicker scans;
      - the series 2 `XXL` alias.
  - `docs/shops.md`: the per-collection categories table, the facts above, and series 2's LE21/LE22 being manual cards to add.
  - `docs/deployment.md`:
    - After the deploy, run `/admin catalog sync` (or wait for the first run) before users set series 1 or 2 lists.
    - Add LE21 and LE22 of series 2 with `/admin catalog add` if wanted.
  - The spec's "Notes from PR 3a": the split into 3a/3b/3c, the `scans`/`numberAliases` options, the puzzle section rule, and the summary's `collections` map.
- [ ] **Step 2: Check.** Run `./bin/mise run format:check`. Expected: clean.
- [ ] **Step 3: Commit** `docs: describe LEGO Minecraft series 1 and 2`
