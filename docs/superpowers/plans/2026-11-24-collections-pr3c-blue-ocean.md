# Collections PR 3c: blue-ocean for series 1 and 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** blue-ocean's single cards of LEGO Minecraft series 1 and 2 are read and stored in their collections, next to series 3's.

**Architecture:**

- One walk of blue-ocean's sticker-cards category serves every collection with blue-ocean settings, like eBay's one run.
- Each product is placed by its URL: the category path (`trading-card-collection-serie-1`) or the product code in a root-level URL (`…-702351-09`).
- A title or picture that names another series contradicts the placement, and the product is skipped.
- The runner stores the run with the 3b machinery: `ShopAdapter.collections`, per-collection storing, and shared alert keys.

**Tech Stack:** Bun, TypeScript, cheerio, Drizzle on SQLite.

**Spec:** `docs/superpowers/specs/2026-11-19-multi-collection-design.md`. Read these sections:

- "Shops per collection": the blue-ocean bullet.
- "Notes from PR 3a" and "Notes from PR 3b".

## Facts (live probe 2026-11-24, `…/lego-minecraft-sticker-cards/?p=N`, 31 pages, 733 products)

The category mixes four product families. Each is told apart by its URL and its picture file:

| Series | Category path in the URL | Root URL code | Picture file | Title |
| --- | --- | --- | --- | --- |
| 1 | `/lego/lego-minecraft/trading-card-collection-serie-1/18166/nummer-250-i-…` | `/nummer-009-i-comic-alex-i-lego-minecraft-tcc-1-702351-09` | `250_lego_minecraft_tcc-01_de.jpg` | `Nummer 250 I Schildkröte I LEGO Minecraft TCC 1` |
| 2 | `/lego/lego-minecraft/trading-card-collection-boom-bastic/22122/nummer-266-i-…` | `/nummer-009-i-zombie-00702502-09` | `249_lego_minecraft_tcc-02.jpg` | `Nummer 266 I Never trust this chef` (no series word) |
| 3 | none | `/nr.-12-team-wolf-skin-…-tcc-on-fire-2dd00088-16` | as today | `Nr. 12 Team Wolf Skin … LEGO Minecraft TCC "On Fire"` (the title's Nr. is wrong; the URL suffix is the id, as today) |
| stickers | `/lego/lego-minecraft/stickerserie-1/…` | `/nummer-009-i-lego-minecraft-sticker-00702506-09` | `…_sticker2025.jpg` | `Nummer 165 I LEGO® Minecraft Sticker` |

**Counts per series:**

- **Series 1:** 254 products, of which 250 are singles (`Nummer 001` to `250`) and 4 are packs (`LEGO Minecraft TCC 1 - Display` …).
- **Series 2:** 256 products, of which 254 are singles and 2 are packs. The gaps in its numbering are the numbers out of stock.
- **Series 3:** 3 singles left.

**Other facts:**

- The title's three-digit number always equals the URL's number: the slug `nummer-NNN` or the suffix `-NN`.
- Prices read through the existing `aria-label` (`Preis: 0.8`), and stock through "Auf Lager".
- Puzzle singles read `Nummer 164 I Puzzle I LEGO Minecraft TCC 1`.
- The series 2 category (`…/trading-card-collection-boom-bastic/`) holds exactly the series 2 products of the sticker walk.
- No series 1 category page exists.

## Global Constraints

- All tasks run through `./bin/mise run <task>`. Every non-test source file has a `*.test.ts`.
- Commits:
  - Conventional Commits (scopes `shops`, `bot`, `docs`), `git commit -s`.
  - Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never use `--no-verify`.
- Shop requests:
  - User-Agent `minecraft-cards-bot/1.0 (+hourly stock check)`, 20 s timeout.
  - 1500 ms between pages, through the one blue-ocean pacer in `adapters.ts`.
- blue-ocean's rules stay as they are:
  - A page that is not a category page is a `ShopLayoutError`.
  - So is a walk with no card at all.
  - The page cap still applies.
  - The `.cms-page` check stays.
  - The recommendation slider is still ignored.
- Anti-goal (spec): a card of another collection must never be alerted. When unsure, give no id.
- No series 3 regression. Today's `blueOcean.test.ts` cases keep their listings and counts, tagged `lego-minecraft-3`.

## Review Focus

1. **A sticker** (`Nummer 165 I LEGO® Minecraft Sticker`, code `00702506`, `stickerserie-1`) never becomes a card of any collection. Pinned in Task 2.
2. **A placement the title or picture contradicts gives no listing.** Example: a URL placing a product in series 1 while its title names `On Fire`, `TCC 2` or `Boom`, or its picture is `_tcc-02`. It is counted `skippedExcluded`. Pinned in Task 2.
3. **A title number that differs from the URL number gives no id.** It is counted `skippedNoId`, never stored with either number. Pinned in Task 2.
4. **A walk without any card of one covered collection**, say if blue-ocean drops series 2, is a shop error of that collection. Its stored listings are untouched, and the others are stored. Pinned in Task 3.
5. **Series 3 reads as before:** the URL-suffix id and `idConflict` from the picture's `P<id>`. Pinned by the existing tests in Task 2.

---

### Task 1: Fixtures and settings

**Files:**

- Create:
  - `src/test/fixtures/blue-ocean-tcc-p2.html`: page 2 of the probe, with series 1, series 2 and sticker rows.
  - `src/test/fixtures/blue-ocean-tcc-p31.html`: page 31, with the root-level `Nummer 001`–`009` of series 1 and 2 and the packs.
- Modify:
  - `src/bot/collections/ids.ts`
  - `legoMinecraft1.ts`, `legoMinecraft2.ts`, `legoMinecraft3.ts`, and their tests
  - `src/bot/collections/index.test.ts`

**Interfaces:**

- Produces:

  ```ts
  /** How blue-ocean's sticker-cards walk tells this collection's products. */
  export interface BlueOceanSettings {
    /** The category path segment of a product URL (`trading-card-collection-serie-1`). */
    readonly categoryPath?: string;
    /** The product code before a root URL's card number (`702351` in `…-702351-09`). */
    readonly productCode: string;
    /** The picture file part naming the series (`_tcc-01`); absent for series 3. */
    readonly picture?: string;
    /** A title must match this; series 3: `On Fire`, series 1: `TCC 1`; series 2: none. */
    readonly title?: RegExp;
  }
  ```

  - `CollectionShops['blue-ocean']?: BlueOceanSettings`.
  - Series 1: `{ categoryPath: 'trading-card-collection-serie-1', productCode: '702351', picture: '_tcc-01', title: /\bTCC\s*1\b/i }`.
  - Series 2: `{ categoryPath: 'trading-card-collection-boom-bastic', productCode: '00702502', picture: '_tcc-02' }`.
  - Series 3: `{ productCode: '2dd00088', title: /on fire/i }`.

- [ ] **Step 1:** Copy the two probe pages into `src/test/fixtures/` as they are. Like the existing blue-ocean fixtures, they hold no customer data.
- [ ] **Step 2:** Write failing tests in the definition tests: each definition's `shops['blue-ocean']` equals the values above. In `index.test.ts`, replace "blue-ocean is read for series 3 only" with "every collection is on blue-ocean, each with its own product code".
- [ ] **Step 3:** Run `./bin/mise run test src/bot/collections`. Expected: FAIL.
- [ ] **Step 4:** Implement the type and the three settings.
  - Remove the series-3-only blue-ocean rule from `checkSettings` (`adapters.ts`).
  - Refuse settings with an empty `productCode`, and a `title` with the `g` or `y` flag, as eBay does.
- [ ] **Step 5:** Run `./bin/mise run test`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat(shops): blue-ocean settings for every LEGO Minecraft collection`.

### Task 2: Parser places each product in its collection

**Files:**

- Modify: `src/bot/shops/blueOcean.ts` and `blueOcean.test.ts`

**Interfaces:**

- Consumes: `BlueOceanSettings` (Task 1).
- Produces:
  - `BlueOceanCollection = BlueOceanSettings & { readonly id: CollectionId }`.
  - `blueOceanCollectionsOf(definitions)`, as `ebayCollectionsOf` does.
  - `parseBlueOceanPage(html, collections: readonly BlueOceanCollection[] = BLUE_OCEAN_COLLECTIONS)` returns today's fields plus `skippedExcluded: number`. Each listing carries `collection`.

**Placing a product box:**

1. **Find the collection.** The URL's category path matches a collection's `categoryPath`. Otherwise its root slug ends in `-<productCode>-<NN>`; series 3's suffix form, `-2dd00088-<NN>`, also counts. A product matching no collection's URL is not a card of this walk (stickers, packs, other brands). It is not counted.
2. **Check the title and picture.** The placement fails if either holds:
   - the collection has a `title` and the title does not match it;
   - the title or picture names another collection: another collection's `title` matches, or the picture contains another collection's `picture`.

   A failed placement is counted `skippedExcluded`.
3. **Read the card id.**
   - **Series 3:** the URL suffix id and `idConflict` against the picture's `P<id>`, as today.
   - **Collections with a `categoryPath`:** the title's `Nummer NNN`, normalized. It must equal the URL's number, which is the slug's `nummer-NNN` or the suffix `-NN`. Otherwise the product is counted `skippedNoId` and logged at warn. A pack (no `Nummer`) is not a card and is not counted.
   - **Picture number:** set `idConflict` when the picture's leading number (`250_lego_minecraft_tcc-01`) differs from the id.

- [ ] **Step 1: Failing tests.**
  - `the series 1 and 2 page places every single in its collection`: on `blue-ocean-tcc-p2.html`, every listing is series 1 or 2. Pin the count per collection and three listings by `[collection, cardIds, price, available]`. Example: `Nummer 250 I Schildkröte I LEGO Minecraft TCC 1` gives `['lego-minecraft-1', ['250'], 80, true]`.
  - `the root-level singles 1 to 9 are placed by their product code`: on `blue-ocean-tcc-p31.html`, `Nummer 001 I Steve I LEGO Minecraft TCC 1` is series 1 #1 and `Nummer 001 I Alex` is series 2 #1. The packs give no listing.
  - `a sticker never becomes a card` (Review Focus 1): no listing, and not counted.
  - `a title or picture naming another series excludes the product` (Review Focus 2): hand-made boxes.
    - A series 1 URL titled `Nummer 012 I Steve I LEGO Minecraft TCC "On Fire"`.
    - A series 2 category URL with a `_tcc-01` picture.
    - A series 1 URL without `TCC 1` in its title.

    Each gives no listing and `skippedExcluded: 1`.
  - `a title number other than the URL's gives no id` (Review Focus 3): `Nummer 013` at `…/nummer-012-i-…` gives no listing and `skippedNoId: 1`.
  - The existing series 3 tests pass with each listing's `collection: 'lego-minecraft-3'` (Review Focus 5).
- [ ] **Step 2:** Run `./bin/mise run test src/bot/shops/blueOcean.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the Produces list. `isOnFireCardTitle` stays for series 3's title check, or is replaced by its `title` setting. Remove `CARD_TITLE_MARKER` if unused.
- [ ] **Step 4:** Run `./bin/mise run test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(shops): read blue-ocean's series 1 and 2 singles`.

### Task 3: One blue-ocean walk for every collection

**Files:**

- Modify:
  - `src/bot/shops/blueOcean.ts` (the fetcher)
  - `src/bot/shops/adapters.ts`
  - `src/bot/shops/types.ts`
  - `src/bot/shops/ebay.ts`
  - `src/bot/check/runner.ts`
  - their tests
  - docs naming `emptySearches`

**Interfaces:**

- Produces:
  - `createBlueOceanFetcher(fetchFn?, options?, collections?: readonly BlueOceanCollection[])`. It walks the category once and returns every page's listings.
    - It reports `emptyCollections`: the covered collections with no card listing in the walk.
    - It throws `ShopLayoutError` as today when there is no card at all.
  - `FetchResult.emptySearches` is renamed to `emptyCollections`, with one doc covering eBay (searches with no usable item) and blue-ocean (no card in the walk).
    - The eBay fetcher and the runner follow the rename.
    - The runner's message names the shop's case: eBay "returned no usable items", blue-ocean "has no card on any page".
  - `createShopAdapters` builds one blue-ocean adapter, as it does for eBay:
    - `collections` are the ids with blue-ocean settings, in registry order;
    - `collection` is `LEGACY_COLLECTION` when it is covered, else the first id;
    - it uses the one blue-ocean pacer.
  - Alert keys of the shared walk are `shop-error:blue-ocean` and `shop-outside:blue-ocean`. Per-collection storing keeps `shop-error:blue-ocean:<collection>`.

- [ ] **Step 1: Failing tests.**
  - `blueOcean.test.ts`: `one walk serves every collection`. Use the fixture pages p2, p31 and the empty p99, and check that the listings carry series 1 and 2.
  - `blueOcean.test.ts`: `a walk without series 2 cards reports it in emptyCollections` (Review Focus 4).
  - `adapters.test.ts`: `one blue-ocean adapter covers every collection`, with `enabledShopsOf` listing blue-ocean for all three.
  - `runner.test.ts`: `a shared blue-ocean walk stores each collection and keeps an empty one's listings` (Review Focus 4).
  - Update the eBay tests to the rename.
- [ ] **Step 2:** Run the four test files. Expected: FAIL.
- [ ] **Step 3:** Implement the Produces list. Rule on any test that still expects `shop-error:blue-ocean:lego-minecraft-3` for a fetch error: the key is now `shop-error:blue-ocean`.
- [ ] **Step 4:** Run `./bin/mise run test` and `./bin/mise run test:coverage`. Expected: PASS, with `runner.ts`, `blueOcean.ts` and `adapters.ts` at 100 % of their lines (the CI ratchet).
- [ ] **Step 5:** Commit: `feat(shops): one blue-ocean walk for every collection`.

### Task 4: Docs

- [ ] **Step 1: Update the docs.**
  - **CLAUDE.md:**
    - the blue-ocean decision: placement by URL, the title and picture checks, `Nummer NNN` equal to the URL number, stickers ignored;
    - the Invariants line naming eBay's shared keys, which now name blue-ocean too;
    - drop "blue-ocean stays series 3 only (PR 3c …)".
  - **`docs/shops.md`:** the blue-ocean row and the per-collection table (series 1 and 2 now yes), plus the probe facts above.
  - **The spec:** add a "Notes from PR 3c" section. It says the shared-run machinery serves blue-ocean too, and that `emptySearches` is now `emptyCollections`.
- [ ] **Step 2:** Run `./bin/mise run format:check`. Expected: clean.
- [ ] **Step 3:** Commit: `docs: describe blue-ocean across collections`.
