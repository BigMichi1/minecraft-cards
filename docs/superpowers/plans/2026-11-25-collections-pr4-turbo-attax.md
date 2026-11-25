# Collections PR 4: Topps F1 Turbo Attax 2026 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the collection `turbo-attax-2026`. Its catalog comes from laststicker, and it is watched on collect-it and eBay with its own card ids.

**Architecture:**

- A card id rule per collection (`CardIdRule`, in the definition) replaces the one Minecraft rule wherever an id is read for a collection:
  - the laststicker sync;
  - card lists;
  - commands;
  - collect-it titles.
- Sorting and formatting stay one function for every collection: base numbers first, then the prefixes alphabetically.
- On collect-it, the title's first part is read with the collection's rule, and the last part may be a year (`- 2026`).
- On eBay, each collection's settings name the id forms its titles are read with:
  - Minecraft keeps today's forms.
  - Turbo Attax gets its own reader, with an exclusion pattern for parallels.
- The page cap per search rises from 5 to 30, so the broad Turbo Attax search is read whole.

**Tech Stack:** Bun, TypeScript, cheerio, Drizzle on SQLite.

**Spec:** `docs/superpowers/specs/2026-11-19-multi-collection-design.md`. Read these sections:

- "Collection registry" (the id rule).
- "Shops per collection" (the collect-it bullet).
- "eBay" (the Turbo Attax title forms and parallels).
- "Notes from PR 1", "Notes from PR 2a", "Notes from PR 3a" and "Notes from PR 3b" (the Step 4 lines).

## Facts (live probe 2026-11-25)

**laststicker** (`/de/cards/topps_formula_1_turbo_attax_2026/`, set id 12348):

- 422 rows.
  - Base cards `1`–`353`, without `135`.
  - Prefixed codes: `LE1`–`LE18` (section `-`, type `Limited Edition`), `BG1`–`BG2`, `GG1`–`GG8`, `GU1`–`GU11`, `SUN1`–`SUN11`.
  - Relics: `MR-ALO` … `MR-VER` (10) and `RR-ALB` … `RR-WEB` (10).
- No puzzle sections.
- Scans exist for the numbered cards and the prefixed codes (`1.jpg`, `le1.jpg`, `gg8.jpg`, `sun1.jpg`, `bg1.jpg`). They answer 404 for the relics (`mr-ham.jpg`, `rr-alb.jpg`), so relics are `no_reference` (spec "Matcher").
- laststicker is wrong at #134 and #135:
  - Its #134 is named "Valtteri Bottas", but its scan shows Sergio Perez.
  - It has no #135.
  - collect-it has `134 - Sergio Perez` and `135 - Valtteri Bottas`.
  - After deploy, the admin adds #135 (`/admin catalog add collection:turbo-attax-2026 card:135 name:Valtteri Bottas`). The maintainer may correct #134's name on laststicker.

**collect-it** (`/sammelkarten/formel1/Topps-Turbo-Attax-Formel-1-2026/Einzelkarten`, `_sN` pages):

- 11 pages, `Du hast … 303 Artikel…`. Every box is in stock: sold-out cards are hidden, as in Minecraft.
- Title forms:
  - `4 - Lando Norris - 2026`
  - `344 - George Russell - F1 Gold - 2026`
  - `GG8 - Michael Schumacher - Greats Of The Grid - Limited Edition - 2026`
  - `MR-HAM - Lewis Hamilton - Manufactured Relic - 2026`
- Every title ends with ` - 2026`.

**eBay** (`EBAY_DE`):

- `turbo attax 2026` has 4782 results. The cap of 5 × 200 would cut it, and the cut search would alert every day.
- The results are mostly single cards (category 261328 "Trading Card Einzelkarten", 120 of 200), and most sellers are German.
- An unseen eBay listing stays available for 24 h (`EBAY_MISSING_GRACE_MS`), so the order shifting while 24 pages are read does not re-notify anyone.
- Title forms seen:
  - `#340`, `# 16`, `NO 264`, `Nr. 12`
  - `LE4`, `#LE6`, `BG 2`, `#GG1`
  - `MR-VER`, `MRSTE`
- Lots list several numbers: `#157 #163 #174`.
- Parallels and other non-checklist cards are what this collection must never read as a checklist card:
  - fractions: `03/99`, `/94`, `100/87`, `ATL-6/11/13`
  - `Refractor`, `Pink`, `Rainbow`, `Parallel`/`Variante`
  - `Gold`, but not `F1 Gold` or `Black Gold`, which are checklist sections
- A title naming another year (`Miami GP 2023`) is unclear and gives nothing.

## Global Constraints

- All tasks run through `./bin/mise run <task>`. Every non-test source file has a `*.test.ts`.
- Commits:
  - Conventional Commits (scopes `cards`, `shops`, `ebay`, `commands`, `bot`, `docs`), `git commit -s`.
  - Every message ends with the Co-Authored-By and Claude-Session lines.
  - Never use `--no-verify`.
- Shop and laststicker requests:
  - User-Agent `minecraft-cards-bot/1.0 (+hourly stock check)`, 20 s timeout.
  - 1500 ms between pages of one host.
- Card ids are canonical strings, unique per collection:
  - Minecraft: `12`, `LE8`, `XXL1`.
  - Turbo Attax: `12`, `LE4`, `BG2`, `GG8`, `GU7`, `SUN1`, `MR-HAM`, `RR-ALB`.
  - No leading zeros, uppercase.
- A false id sends a false DM. When unsure, give no id (spec "Anti-goals").
- No parallels (spec "Non-goals").
- Fixtures:
  - fetched with the bot's User-Agent;
  - eBay fixtures with ids and URLs replaced and no seller data.
- Never log `EBAY_CLIENT_SECRET` or tokens.

## Review Focus

1. **Ids never cross between collections' rules.**
   - `/missing set collection:lego-minecraft-3 GG8` refuses `GG8`.
   - `MR-HAM` passes only for Turbo Attax.
   - A Minecraft eBay title is never read with the Turbo Attax forms, and the reverse.
   - Test: `cardId.test.ts` "each rule refuses the other's prefixes", and an `ebay.test.ts` case.
2. **Parallel titles give no id**, even when they carry a `#N`:
   - `#323 limitiert 03/99`
   - `Chrome Refractor … #322`
   - `Gold Relic`
   - `GOLD LE5`

   `F1 Gold … #345` and `BG 1 … (Black Gold)` still give their ids. Test: the fixture table in `ebayTurboAttax.test.ts`.

3. **Series 3's name check is untouched by the new collection.** A Turbo Attax catalog not synced yet does not stop it, and does not raise `shop-names:ebay:…`. Test: an `ebay.test.ts` case.
4. **The cap of 30 pages** (built as a per-collection `maxPages`, Turbo Attax 40).
   - Minecraft searches end where they did.
   - A 4782-result search is read whole and not reported as truncated.
   - A search above 6000 is still cut and alerted.

   Test: the `ebay.test.ts` walk cases, with the cap taken from the exported constant.

5. **Relic ids in the one-click Confirm.** `admin-confirm:<listing>:MR-HAM:<fp>` decodes. The `-` inside the id does not break the `:` split. Test: a `buttonIds.test.ts` case.

---

### Task 1: Card id rules

**Files:**

- Modify: `src/bot/cards/cardId.ts`
- Test: `src/bot/cards/cardId.test.ts`
- Modify: `src/test/cardIds.ts` (`ids(…)` takes an optional rule)

**Interfaces:**

- Produces:
  ```ts
  export interface CardIdRule {
    /** Letters before a card number, besides none (Minecraft `LE`, `XXL`). Uppercase. */
    readonly prefixes: readonly string[];
    /** Two-letter families of three-letter codes after a dash (Turbo Attax `MR`, `RR`). */
    readonly codes?: readonly string[];
  }
  export const MINECRAFT_CARD_IDS: CardIdRule; // { prefixes: ['LE', 'XXL'] }
  export const TURBO_ATTAX_CARD_IDS: CardIdRule; // { prefixes: ['BG','GG','GU','LE','SUN'], codes: ['MR','RR'] }
  export function normalizeCardIdIn(rule: CardIdRule, raw: string): CardId | null;
  export function normalizeCardId(raw: string): CardId | null; // = normalizeCardIdIn(MINECRAFT_CARD_IDS, raw)
  export function parseCardList(
    input: string,
    rule?: CardIdRule
  ): { ids: CardId[]; invalid: string[] };
  export function compareCardIds(a: CardId, b: CardId): number; // every rule
  export function formatCardList(ids: readonly CardId[]): string; // every rule
  export function cardType(id: CardId): CardType; // LE → le, XXL → xxl, else base (unchanged values)
  ```
- Accepted raw forms:
  - Numbers: `#? N`, leading zeros dropped.
  - Prefixed numbers: a prefix of the rule, with an optional space and leading zeros (`LE 08` → `LE8`, `sun01` → `SUN1`, `#GG1` → `GG1`).
  - Codes: a family of the rule, then a dash, a space or nothing, then three letters (`mr-ham`, `MR HAM`, `MRHAM` → `MR-HAM`).
- Ranges (`parseCardList`):
  - Allowed between numbers with the same prefix (`GG1-8`, `LE1-LE18`).
  - Never between codes.
- Order:
  - Bare numbers numerically first.
  - Then prefixed ids, by prefix alphabetically (`BG` < `GG` < `GU` < `LE` < `MR-` < `RR-` < `SUN` < `XXL`), then by number, and codes by their letters.
  - Minecraft's order (base, LE, XXL) is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - "each rule refuses the other's prefixes":
    - `normalizeCardIdIn(MINECRAFT_CARD_IDS, 'GG8')` is null.
    - `normalizeCardIdIn(TURBO_ATTAX_CARD_IDS, 'XXL1')` is null.
    - `normalizeCardIdIn(TURBO_ATTAX_CARD_IDS, 'MR-HAM')` is `MR-HAM`.
  - "Turbo Attax forms": the raw forms above, plus `MR-HAMX` and `MR-HA` giving null.
  - "parseCardList with a rule": `'1-3, GG1-2, mr-ham, LE 4'` gives `['1','2','3','GG1','GG2','LE4','MR-HAM']`, and `'MR-HAM-MR-VER'` is invalid.
  - "compare and format across prefixes": `formatCardList` of `[SUN2, 3, GG1, SUN1, MR-HAM, 1, 2]` is `'1-3, GG1, MR-HAM, SUN1-2'`.
  - The Minecraft cases stay unchanged.
- [ ] **Step 2: Run.**
  - Run: `./bin/mise run test src/bot/cards/cardId.test.ts`
  - Expected: FAIL (no `normalizeCardIdIn`).
- [ ] **Step 3: Implement.**
  - One parser builds the canonical id from the rule.
  - `toId` stays the only place a string becomes a `CardId`.
  - Compare and format parse any canonical id with `^([A-Z]+-?)?(\d+)?$`, so they need no rule.
- [ ] **Step 4: Run.**
  - Run: `./bin/mise run test src/bot/cards/cardId.test.ts`
  - Expected: PASS. Then the full `./bin/mise run test`: PASS.
- [ ] **Step 5: Commit** `feat(cards): card id rules per collection, with Turbo Attax's prefixes and relic codes`

### Task 2: The `turbo-attax-2026` collection, its catalog and its commands

**Files:**

- Create: `src/bot/collections/turboAttax2026.ts` and its test.
- Modify:
  - `collections/ids.ts`: `COLLECTION_IDS` gains `'turbo-attax-2026'` (last); `CollectionDefinition.cardIds: CardIdRule` is required.
  - `collections/index.ts`: `DEFINITIONS`, `cardIdRuleOf`, `anyCollectionCardId`.
  - The three Minecraft definitions: `cardIds: MINECRAFT_CARD_IDS`.
- Modify `catalog/laststicker.ts`: `fetchLaststickerSet(set, options, fetchFn, rule)`.
- Modify `catalog/sync.ts`: the definition's rule is passed to the fetch.
- Modify `database/catalogManager.ts`:
  - `parseKnownCardList` uses `cardIdRuleOf(collection)`.
  - The import preview `counts` is per prefix (`{ base: n, LE: n, GG: n, … }`, only those present).
- Modify the commands:
  - `commands/card.ts`;
  - `commands/admin.ts` (`/admin map`, `/admin catalog add|edit|remove|release`): `normalizeCardIdIn(cardIdRuleOf(collection), token)`;
  - the reply that renders the preview counts.
- Modify `interactions/buttonIds.ts`: the Confirm decode uses `anyCollectionCardId`.
- Fixture: `src/test/fixtures/laststicker-turbo-attax-2026.html` (the probe page, scripts and ads removed, the `#checklist` table whole).
- Test:
  - `collections/*.test.ts`
  - `catalog/laststicker.test.ts`, `catalog/sync.test.ts`
  - `database/catalogManager.test.ts`
  - `commands/card.test.ts`, `commands/admin.test.ts`, `commands/missing.test.ts`
  - `interactions/buttonIds.test.ts`

**Interfaces:**

- Consumes from Task 1: `CardIdRule`, `MINECRAFT_CARD_IDS`, `TURBO_ATTAX_CARD_IDS`, `normalizeCardIdIn`, `parseCardList(input, rule)`.
- Produces:
  ```ts
  export const turboAttax2026: CollectionDefinition<'turbo-attax-2026'> = {
    id: 'turbo-attax-2026',
    name: 'Topps F1 Turbo Attax 2026',
    cardIds: TURBO_ATTAX_CARD_IDS,
    laststicker: { set: 'topps_formula_1_turbo_attax_2026' },
    shops: {}, // collect-it in Task 3, eBay in Task 4
  };
  export function cardIdRuleOf(collection: CollectionId): CardIdRule; // collections/index.ts
  /** A canonical id of any registry rule (button ids carry ids of every collection). */
  export function anyCollectionCardId(raw: string): CardId | null; // collections/index.ts
  ```
- No `referenceFallbackShop`: relics and #135 are `no_reference` unless the admin gives a picture.
- No migration: `collection` is unchecked text, and `cards.type` keeps `base`/`le`/`xxl` (`cardType`). Turbo Attax's `LE` cards are `le`; its other codes are `base`. Only the import preview read it, and that becomes per prefix.

- [ ] **Step 1: Write the failing tests.**
  - laststicker: the fixture parses with `TURBO_ATTAX_CARD_IDS` into 422 rows, set id 12348:
    - `MR-HAM`'s picture is `…/12348/mr-ham.jpg`;
    - `LE1`'s kind is `-` and its variant `Limited Edition`;
    - no `135`, and no row is a puzzle.
  - It throws `CatalogLayoutError` naming `GG1` with `MINECRAFT_CARD_IDS`.
  - sync: a Turbo Attax sync stores 422 cards through an injected `fetchSet`, which receives the definition's rule.
  - catalogManager:
    - `parseKnownCardList('turbo-attax-2026', 'GG1, MR-HAM')` is valid against a catalog holding them;
    - `parseKnownCardList('lego-minecraft-3', 'GG1')` names `GG1` invalid;
    - the preview counts for `[1, LE1, GG1, GG2]` are `{ base: 1, LE: 1, GG: 2 }`.
  - commands:
    - `/card collection:turbo-attax-2026 number:mr-ham` finds `MR-HAM`;
    - `/admin catalog add collection:turbo-attax-2026 card:135 name:Valtteri Bottas` stores a manual `135`;
    - `/admin catalog add collection:lego-minecraft-3 card:GG1` replies "Not a card number".
  - buttonIds: `decodeConfirmId('admin-confirm:7:MR-HAM,GG8:<fp>')` gives `['MR-HAM','GG8']`.
  - registry:
    - the ids test covers the new slug;
    - `collectionChoices()` has 4 entries;
    - every definition names a rule.
- [ ] **Step 2: Run.**
  - Run: `./bin/mise run test src/bot/collections src/bot/catalog src/bot/database/catalogManager.test.ts src/bot/commands src/bot/interactions/buttonIds.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement** as in the Files list.
  - Everything that reads ids for a named collection uses `cardIdRuleOf`.
  - The Minecraft-only shops keep `normalizeCardId`: sammel-ente, blue-ocean, and eBay's Minecraft forms.
- [ ] **Step 4: Run.**
  - Run: `./bin/mise run typecheck && ./bin/mise run test`
  - Expected: PASS.
- [ ] **Step 5: Commit** `feat(cards): the Topps F1 Turbo Attax 2026 collection, its laststicker catalog and card ids`

### Task 3: collect-it reads Turbo Attax titles

**Files:**

- Modify: `src/bot/shops/collectIt.ts`
  - `parseCollectItPage(html, series, rule = MINECRAFT_CARD_IDS)`;
  - `createCollectItFetcher(settings, fetchFn, rule)`;
  - `TITLE_PATTERN` reads the first `-` part as the id token;
  - `SERIES_SUFFIX` also takes a year.
- Modify: `src/bot/shops/types.ts`: `sameSeries` compares whole labels for a year (`2026` = `2026`, `2026` ≠ `Serie 2`).
- Modify: `adapters.ts`: `fetcherFor` passes `definition.cardIds`.
- Modify: `turboAttax2026.ts`: `'collect-it': { category: 'https://www.collect-it.de/sammelkarten/formel1/Topps-Turbo-Attax-Formel-1-2026/Einzelkarten', series: '2026' }`.
- Modify: `ids.ts`, the `CategoryShopSettings.series` doc (`Serie N` or a year).
- Fixtures:
  - `src/test/fixtures/collect-it-turbo-attax-p1.html` (page 1, in the probe as fetched);
  - `collect-it-turbo-attax-p11.html` (the last page: relics, `Du hast alle 303 Artikel gesehen`).
- Test: `collectIt.test.ts`, `types.test.ts`, `adapters.test.ts`, `turboAttax2026.test.ts`.

**Interfaces:**

- Consumes: `CardIdRule`, `normalizeCardIdIn` (Task 1), and `definition.cardIds` (Task 2).
- Title rule:
  - `^(.+?) - (.+?)(?: - |$)`. The first part, spaces removed, goes through the rule (`XXL 1` → `XXL1`, `MR-HAM`).
  - A first part the rule rejects is `skippedNoId`, which fails the walk as today.
  - The series label is the last `-` part when it is `Serie N` or a year `(19|20)\d\d`.

- [ ] **Step 1: Write the failing tests.**
  - Page 1 with `'2026'` and the Turbo Attax rule:
    - 30 listings, the first `1` (`Team Logo McLaren Mastercard`);
    - `3` (`Lando Norris / Oscar Piastri`);
    - no skips, no excluded.
  - Page 11: `GG8`'s name is `Michael Schumacher`, and `MR-HAM`'s; `countText` is `Du hast alle 303 Artikel gesehen`, no skips.
  - The same page 1 read with the Minecraft rule and `'Serie 1'`: every box is `excluded` (its year label is another series), none a skip.
  - The series 1 fixture with `'2026'`: all excluded.
  - `sameSeries('2026','2026')` is true; `sameSeries('2026','Serie 2')` is false.
  - The existing series 1 and 3 cases stay unchanged.
- [ ] **Step 2: Run.**
  - Run: `./bin/mise run test src/bot/shops/collectIt.test.ts src/bot/shops/types.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.**
  - Run: `./bin/mise run test`
  - Expected: PASS.
- [ ] **Step 5: Commit** `feat(shops): collect-it reads Turbo Attax 2026 singles`

### Task 4: eBay reads Turbo Attax titles

**Files:**

- Create: `src/bot/shops/ebayTitleWords.ts` and its test. These move out of `ebay.ts` unchanged:
  - `COUNT_WORDS` and its word lists;
  - `wordsPattern`, `NOT_A_COUNT`, `COUNT_AFTER`, `MULTI_PICK_PATTERN`, `LETTER`.

  `ebay.ts` re-exports `COUNT_WORDS`, and the equality test moves.

- Create: `src/bot/shops/ebayTurboAttax.ts` and its test.
- Modify `src/bot/shops/ebay.ts`:
  - `MAX_PAGES_PER_QUERY` = 30, exported, with its doc giving the probe.
  - Per collection, `idForms` picks the reader and the range check, and `excludes` is a `titleExclusion` reason `parallel`.
  - The name-check rivals (`others`, `namesUnknown`) are only collections with `idForms: 'minecraft'`.
- Modify `collections/ids.ts`, `EbayCollectionSettings`:
  - `idForms: 'minecraft' | 'turbo-attax'` (required);
  - `excludes?: RegExp`, refused at start with a `g`/`y` flag (`checkSettings`).
- Modify the definitions: the Minecraft ones get `idForms: 'minecraft'`, and Turbo Attax gets:
  ```ts
  ebay: {
    queries: ['turbo attax 2026'],
    idForms: 'turbo-attax',
    // "Topps Turbo Attax 2026 F1 Gold Max Verstappen #345": both words, and no other year.
    series: /^(?=.*\bTurbo\s*Attax\b)(?=.*(?<!\d)2026(?!\d))(?!.*(?<!\d)(?:19|20)(?!26)\d\d(?!\d))/i,
    // Parallels: other cards than the checklist's (spec "Non-goals").
    excludes: /\b(?:pink|parallel|variante|refractor|superfractor|rainbow|green)\b|\bgold\b(?<!\b(?:F1®?|Black)\s+gold)|\d\s*\/\s*\d/i,
  }
  ```
  The exact regexes are refined against the fixture. Every fixture row is reviewed by hand.
- Fixture: `src/test/fixtures/ebay-search-turbo-attax.json`. About 40 items from the probe:
  - singles of every form;
  - lots;
  - pick lists and ranges;
  - parallels;
  - another year;
  - packs and tins.

  Ids and URLs are replaced, there is no seller data, and the shape is that of `ebay-search-series-1-2.json`.

- Test: `ebay.test.ts`, `ebayTurboAttax.test.ts`, `ebayTitleWords.test.ts`, `adapters.test.ts`, `turboAttax2026.test.ts`.

**Interfaces:**

- Consumes: `TURBO_ATTAX_CARD_IDS`, `normalizeCardIdIn` (Task 1), and the definition (Task 2).
- Produces:
  ```ts
  /** Card ids a Turbo Attax title names: `#N`, `Nr./No. N`, `LE4`, `BG 2`, `#GG1`, `MR-VER`, `MRSTE`; numbers of 1-3 digits not followed by a count. */
  export function readTurboAttaxCardIds(title: string): CardId[];
  /** A number range in any Turbo Attax form (`#1 - 264`, `(1-288)`, `GG1-GG8`, `#136-150`). */
  export function hasTurboAttaxRange(title: string): boolean;
  ```
- What is never read:
  - bare numbers (`Ferrari 8 Karten`, `237 - Carlos Sainz`);
  - `Karte N` / `Card N` (`Trading Card 2026`).

  This follows the spec rule "when unsure, give no id".

- Picture candidates and the name check stay series 3 only (unchanged).

- [ ] **Step 1: Write the failing tests.**
  - `ebayTurboAttax.test.ts`: a table of every fixture title with its ids, including:
    - `#340` → `340`
    - `BG 2` → `BG2`
    - `#GG1` → `GG1`
    - `MRSTE` → `MR-STE`
    - `NO 264` → `264`
    - `#157 #163 #174` → three ids
    - `1:250` gives nothing extra.
  - `ebay.test.ts`:
    - The Turbo Attax fixture through `createEbayFetcher` with every registry collection:
      - each single lands in `turbo-attax-2026` with its ids;
      - parallels, pick lists, ranges and the 2023 title are excluded;
      - a Minecraft `Serie 3 … LE 5` title still reads `LE5` in series 3.
    - Series 3's name check with Turbo Attax's names empty still reads `Karte 131 - Ghast`, with no `namesUnknown`.
    - A walk with total 4782 reads 24 pages with no `truncated`.
    - A total of 7000 reads `MAX_PAGES_PER_QUERY` pages and is truncated.
  - `adapters.test.ts`: `excludes` with a `g` flag throws.
- [ ] **Step 2: Run.**
  - Run: `./bin/mise run test src/bot/shops`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Move the words first, with no behaviour change: the existing tests stay green.
  - Then add the reader, the settings and the cap.
- [ ] **Step 4: Run.**
  - Run: `./bin/mise run typecheck && ./bin/mise run lint && ./bin/mise run test`
  - Expected: PASS.
- [ ] **Step 5: Commit** `feat(ebay): read Turbo Attax 2026 titles, without parallels`

### Task 5: Docs

**Files:**

- `CLAUDE.md`:
  - the collections list;
  - the id invariant (per-collection rules);
  - a Turbo Attax decision: collect-it year label, eBay forms and parallels, the 30-page cap, no fallback shop, laststicker's #134/#135.
- `docs/shops.md`: the collect-it Turbo Attax category, and the eBay Turbo Attax forms and cap.
- `docs/image-matching.md`: Turbo Attax references (scans; relics `no_reference`).
- `README.md`: the collections.
- The spec: "Notes from PR 4" (rule per collection, `idForms`, the cap, #134/#135).

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run.**
  - Run: `./bin/mise run format:check`
  - Expected: PASS.
- [ ] **Step 3: Commit** `docs: Topps F1 Turbo Attax 2026`

---

## PR 4b: euro-soccer-cards (Turbo Attax singles)

PR 4b is its own PR. It is branched from PR 4's branch once PR 4 is opened, and rebased onto `main` after PR 4 merges.

### Facts (live probe 2026-11-25, `https://www.euro-soccer-cards.com/gb/topps-turbo-attax-2026/`)

- A Spanish PrestaShop shop with euro prices. It ships to Germany ("Europe zone A", certified mail €5).
- robots.txt allows category pages and `?page=N`. It disallows only sort, filter and search parameters, plus every page for one crawler (PetalBot).
- 11 pages of 36 products (the last has 32). Page 1 says `There are 392 products.`
- Every page has `<link rel="canonical">` naming itself, and `<link rel="next">` until the last page. `?page=12` redirects to page 1, as collect-it does.
- Box: `.product-miniature`.
  - The link is `.product-title a[href]`. Its text is cut (`McLaren Mastercard Formula 1 Team F1...`).
  - The full name is in the picture's `alt`: `Buy Cards <name> Colección Turbo Attax 2026`.
  - Price: `span.price[itemprop=price][content="1.5"]`, plus `meta[itemprop=priceCurrency]`.
  - Stock: `link[itemprop=availability]`, `http://schema.org/InStock` or `OutOfStock`. 30 boxes are OutOfStock, flagged `Out-of-Stock`.
  - Picture: `img[src]` (`…-home_default/…jpg`).
- Sold-out cards stay listed, so a sell-out is read, not inferred.
- The card id is only in the URL slug:
  - `…-f1-team-logos-1`
  - `…-legends-of-the-grid-150-turbo-attax-2026`
  - `…-guardians-of-the-grid-gu-1-turbo-attax-2026`
  - `…-2026-f1-car-184-turbo-attax-2026`: `car` is a section word, so the id is `184`.

  All 392 slugs give distinct ids that laststicker knows, plus `135`.

- Not sold: #343–353 and the relics.

### Review Focus (4b)

1. **A partial walk never marks listings gone.** All of these are `ShopLayoutError`:
   - a missing total;
   - read ≠ total;
   - a canonical that does not name the page;
   - a page with no boxes;
   - the page cap;
   - an unreadable slug, price-less box or unknown availability.
2. **Slug ids:**
   - Only the rule's prefixes count (`gu-1` → `GU1`, `car-184` → `184`).
   - A slug with no trailing number is unreadable (the walk fails).
   - A relic slug `…-mr-ham-turbo-attax-2026` reads `MR-HAM`.
3. **OutOfStock boxes are stored as unavailable, not skipped.** One back in stock re-notifies once (the existing runner rule).

### Task 6: The euro-soccer-cards adapter

**Files:**

- Create: `src/bot/shops/schemaOrg.ts` and its test. `readAvailability` moves out of `collectIt.ts` unchanged, and collect-it imports it.
- Create: `src/bot/shops/euroSoccerCards.ts` and its test.
- Modify `shops/types.ts`: `SHOP_IDS` gains `'euro-soccer-cards'` (last).
- Modify `adapters.ts`:
  - `SHOP_HOSTS['euro-soccer-cards'] = 'www.euro-soccer-cards.com'`;
  - a `fetcherFor` case;
  - the category host check.
- Modify `collections/ids.ts`: `CollectionShops['euro-soccer-cards']?: { readonly category: string }`.
- Modify `turboAttax2026.ts`: `'euro-soccer-cards': { category: 'https://www.euro-soccer-cards.com/gb/topps-turbo-attax-2026/' }`.
- Modify the shop labels: `notify/messages.ts` `SHOP_NAMES` (`euro-soccer-cards`), `commands/stockPage.ts` `SHORT` (`ESC`).
- A migration only if `db:generate` produces one (the `shop` enum is unchecked text in SQLite).
- Fixtures:
  - `src/test/fixtures/euro-soccer-cards-p1.html`;
  - `euro-soccer-cards-p11.html` (the last page: LE, BG and GG cards, `Out-of-Stock` boxes, no `rel="next"`).

**Interfaces:**

- Consumes: `CardIdRule` and `normalizeCardIdIn` (Task 1), `definition.cardIds` (Task 2), and `readAvailability`.
- Produces:
  ```ts
  export function parseEuroSoccerCardsPage(html: string, rule: CardIdRule): EuroSoccerCardsPage;
  // { listings, productCount, total: number | null, canonical, next, skipped: number, firstSkipped: string | null }
  export function slugCardId(url: string, rule: CardIdRule): CardId | null;
  export function createEuroSoccerCardsFetcher(
    settings: { category: string },
    fetchFn: FetchFn,
    rule: CardIdRule
  ): ShopFetcher;
  ```
- Walk:
  - Follow `rel="next"`, up to a 40-page cap.
  - Each page's canonical must equal the URL fetched (page 1 the category, page N `?page=N`).
  - Each page must hold boxes.
  - The total is from page 1 (`There are (\d+) products?\.`), and the boxes read must equal it.
  - Any skipped box is a `ShopLayoutError` (alerted, listings untouched), as on collect-it.
- Listing:
  - `title`: the `alt` without its `Buy Cards ` prefix and ` Colección …` tail (the link text when no `alt`);
  - `cardName`: that title;
  - `price`: from `content`;
  - `available`: from the availability;
  - `format: 'fixed_price'`;
  - the collection from the adapter.

- [ ] **Step 1: Write the failing tests.**
  - `slugCardId` table: the four slug forms above, `…-mr-ham-turbo-attax-2026` → `MR-HAM`, `…-team-logos` → null, and the Minecraft rule on `…-gu-1` → null.
  - Page 1: 36 listings, the first `1` at €1.50 in stock, total 392, `next` `?page=2`.
  - Page 11: 32 listings including `LE1` and `BG1`; `LE3` unavailable; no `next`.
  - Fetcher with a fake fetch serving the two fixtures as an 11-page walk (pages 2–10 built from page 1 with their canonical and next rewritten): a total mismatch, a wrong canonical, a box without a price and the page cap each throw `ShopLayoutError`.
  - adapters: a category on another host throws, and Turbo Attax gets one euro-soccer-cards adapter.
- [ ] **Step 2: Run.**
  - Run: `./bin/mise run test src/bot/shops`
  - Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.**
  - Run: `./bin/mise run typecheck && ./bin/mise run lint && ./bin/mise run test`
  - Expected: PASS.
- [ ] **Step 5: Commit** `feat(shops): euro-soccer-cards for Turbo Attax 2026 singles`

### Task 7: Docs (4b)

- `CLAUDE.md`: architecture (shops list) and a euro-soccer-cards decision (walk rules, slug ids, sold-out boxes listed).
- `docs/shops.md`, `README.md`, and the spec "Notes from PR 4" (the new shop).
- Commit `docs: euro-soccer-cards`.
