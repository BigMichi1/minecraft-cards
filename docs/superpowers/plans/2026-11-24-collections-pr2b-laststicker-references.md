# Collections PR 2b: laststicker scans as references — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make laststicker's scans the image reference of `lego-minecraft-3`, with sammel-ente's picture as the fallback. Compare sammel-ente listings like any other shop's. Re-match every listing once, with one summary for the admin.

**Architecture:**

- A measurement (Task 1) decides whether the switch can ship, and with which threshold values.
- `catalogManager.referenceCatalog` becomes the one source-aware accessor: it picks the admin's picture, the laststicker scan or the shop picture for each card, and says which one.
- The reference loader falls back to the shop picture in the same run when a scan answers 404, and records the 404.
- laststicker picture requests are paced to 1500 ms.
- The `reference` match status goes away.
- A migration sets every unmapped, non-bundle listing to `pending` and keeps its old status, so the run can count what changed and send one summary.

**Tech Stack:** Bun, TypeScript, Drizzle on SQLite, transformers.js (`Xenova/dinov2-small`), discord.js.

**Spec:** `docs/superpowers/specs/2026-11-19-multi-collection-design.md`, sections "Names and reference pictures", "Matcher", "Notes from PR 2a for the later steps" and rollout step 2.

## Global Constraints

- All tasks run through `./bin/mise run <task>`. Every non-test file in `src/` has a `*.test.ts` next to it; `scripts/` and `src/bot/database/schema/*.ts` are exempt.
- Commits:
  - Conventional Commits, scopes `matcher`, `database`, `cards`, `shops`, `notify`, `admin`, `docs`.
  - Commit with `git commit -s`, and end every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Never use `--no-verify`.
- Migrations are generated (`./bin/mise run db:generate`). The SQL is then hand-edited only to append data `UPDATE`s, as 0003 and 0006 did.
- laststicker requests (page and pictures) use User-Agent `minecraft-cards-bot/1.0 (+hourly stock check)`, a 20 s timeout, and 1500 ms between two requests to `www.laststicker.com`. The bot reads only `/de/cards/<set>/` and `/i/cards/…`.
- Validate every URL with `validUrl` before it reaches a discord.js builder.
- Threshold values (`IMAGE_MATCH_THRESHOLD` default, `DECISION_GAP`, `TWIN_SIMILARITY`) change only from the recorded measurement. If no value separates same-card from other-card scores, the PR stops and the numbers go to the maintainer.
- Anti-goal: no series 3 regression. Every existing test keeps passing, changed only where the reference source or the dropped `reference` status requires it.

## Review Focus

1. **A scan that answers 404** (laststicker has no `xxl1` scan):
   - The card uses sammel-ente's picture in that same run, and later runs use it directly.
   - No `reference-unavailable` alert, and no `image_unavailable` for listings of that card.
   - Test in Task 4.
2. **A scan that fails for any other reason** (500, timeout, network):
   - It is a transient failure as today (`image_unavailable`, retried in a day).
   - It is never recorded as missing, and the shop picture is not used for it.
   - Test in Task 4.
3. **A manual card:**
   - It keeps the admin's picture even when sammel-ente has one.
   - Without an admin picture it uses the shop picture.
   - Without either it is `no_picture`.
   - Test in Task 3.
4. **A listing already notified that stays available after the re-match reset** is not notified again. The notification is recorded per availability period. Test in Task 6.
5. **The migration:**
   - An admin-mapped listing (`manual_override = 1`, including a sammel-ente one stored `reference`) stays as the admin left it; a stored `reference` becomes `confirmed`.
   - A bundle stays `bundle`.
   - Test in Task 6.

---

### Task 1: Measure laststicker scans against shop pictures (go/no-go)

**Files:**

- Modify: `scripts/measure-threshold.ts` (new `--reference laststicker` mode)
- Modify: `docs/image-matching.md` (new section "Measurement on laststicker scans (2026-11-24)")
- Maybe modify: `src/bot/matcher/embedder.ts` (`DEFAULT_IMAGE_MATCH_THRESHOLD`) and `src/bot/matcher/identify.ts` (`DECISION_GAP`, `TWIN_SIMILARITY`), with their tests. Only if step 3 shows they must change.

**Interfaces:**

- Consumes: `fetchLaststickerSet(set)` → `{ rows: LaststickerRow[] }` (`pictureUrl`, `cardId`, `puzzle`); `createSammelEnteFetcher`, `createCollectItFetcher`, `createEbayFetcher` (credentials from env); `createTransformersEmbedder`, `cosineSimilarity`, `identifyPicture` from `matcher/identify.ts`.
- Produces: the recorded numbers and, if needed, new constant values. Later tasks use the constants by name only.

- [ ] **Step 1: Add the `--reference laststicker` mode**
  - **References:** the 251 laststicker scans of `blue_ocean_lego_minecraft_on_fire`. A scan that answers 404 is skipped and listed.
  - **Candidates:** the single-card listings of sammel-ente, collect-it and, when `EBAY_CLIENT_ID` is set, eBay. Use only listings with `idSource` `title` and exactly one card id. Use the default model only (`DEFAULT_IMAGE_MODEL`).
  - **Pacing:** at least 1500 ms between two laststicker requests (a plain `sleep` between downloads).
  - **Output, per shop:**
    - True pairs: the listing card _n_ against scan _n_. Print min, median and max.
    - False pairs: card _n_ against the scan of the next card id, as today. Print min, median and max.
    - The errors at the current `IMAGE_MATCH_THRESHOLD` (0.78), and the fewest-errors threshold.
  - **Output, identification:** compare every candidate with all scans through `identifyPicture`, with the current threshold and gap. Print decided / right / wrong counts.
  - **Output, twins:** print every scan pair at or above `TWIN_SIMILARITY` (0.9).

- [ ] **Step 2: Run it**

Run: `./bin/mise run measure:threshold -- --reference laststicker > <workspace>/measure.txt 2>&1`
Expected: one block per shop, an identification block and a twin list. The run takes about 10 minutes (251 paced scans).

- [ ] **Step 3: Decide**
  - **Keep 0.78 / 0.02 / 0.9** when all of these hold:
    - The wrong-card rate at 0.78 is no worse than the recorded 3 % (blue-ocean) and 5 % (collect-it).
    - Identification makes no wrong decision.
    - The twin list is the known twins only (#59 and XXL1, if XXL1 has a scan; LE10/LE11 were one sammel-ente placeholder).
  - **Change a value** only to the measured fewest-errors point, rounded to two decimals, and run the measurement again with it.
  - **Stop** if same-card and other-card scores overlap so much that no threshold keeps both error rates at or below 10 %. Then stop the plan: commit only the doc section with the numbers, and report to the maintainer.

- [ ] **Step 4: Record the result**
  - Write the section in `docs/image-matching.md`: the method, a table per shop as in "Measurement (2026-11-17)", the identification counts, the twins, and the decision with its reason.
  - If a constant changed, update its test's expected value in the same commit.

- [ ] **Step 5: Commit**

```bash
git add scripts/measure-threshold.ts docs/image-matching.md
git commit -s -m "docs(matcher): measure the threshold on laststicker scans"
```

### Task 2: Store shop pictures and missing scans apart

**Files:**

- Modify: `src/bot/database/schema/cards.ts`
- Create (generated): `src/bot/database/migrations/0007_*.sql`, plus `meta/`
- Modify: `src/bot/database/db.test.ts`
- Modify: `src/bot/collections/ids.ts`, `src/bot/collections/legoMinecraft3.ts`, `src/bot/collections/index.test.ts`

**Interfaces:**

- Produces:
  - `cards.shopImageUrl: string | null`: the newest picture of the card from the collection's fallback shop.
  - `cards.laststickerScanMissingAt: number | null`: when the scan last answered 404.
  - `CollectionDefinition.referenceFallbackShop?: ShopId` (type-only import from `shops/types`). `legoMinecraft3.referenceFallbackShop = 'sammel-ente'`.
  - From here on, `cards.referenceImageUrl` is the admin's picture of a manual card only.

- [ ] **Step 1: Failing test in `db.test.ts`**, `migration 0007 moves the shop picture of laststicker cards to shop_image_url`:
  - Apply the migrations up to 0006, as the 0005 test does.
  - Insert a laststicker card (`reference_image_url` = `https://shop-sammel-ente.de/a.jpg`) and a manual card (`reference_image_url` = `https://m/x.jpg`).
  - Migrate.
  - Expect for the laststicker card: `shop_image_url` = `…/a.jpg` and `reference_image_url` null.
  - Expect for the manual card: `reference_image_url` unchanged and `shop_image_url` null.
- [ ] **Step 2: Run it.** `./bin/mise run test src/bot/database/db.test.ts`. Expected: FAIL (no column `shop_image_url`).
- [ ] **Step 3: Implement**
  - Add both columns to `cards.ts`, with doc comments.
  - Run `./bin/mise run db:generate`.
  - Append to the generated SQL:
    ```sql
    --> statement-breakpoint
    UPDATE `cards` SET `shop_image_url` = `reference_image_url`, `reference_image_url` = NULL WHERE `source` = 'laststicker';
    ```
  - Add `referenceFallbackShop` to the definition type and to `legoMinecraft3`.
  - Add a registry test: `lego-minecraft-3 falls back to sammel-ente pictures`.
- [ ] **Step 4: Run it.** Expected: PASS. `./bin/mise run typecheck` is clean.
- [ ] **Step 5: Commit** `feat(database): keep shop pictures apart from the admin's and record missing scans`

### Task 3: One source-aware reference accessor

**Files:**

- Modify: `src/bot/database/catalogManager.ts`, `catalogManager.test.ts`
- Modify: `src/bot/catalog/sync.ts`, `sync.test.ts`
- Modify: `src/bot/check/runner.ts`, `runner.test.ts` (sammel-ente branch)
- Modify: `src/test/catalog.ts` (`setCatalogCards` gains `shopImageUrl` and `scanUrl`)

**Interfaces:**

- Consumes: the Task 2 columns and `referenceFallbackShop`.
- Produces:
  - `export type ReferenceSource = 'laststicker' | 'shop' | 'manual'`.
  - `ReferenceCard` gains `source: ReferenceSource` and `fallbackUrl: string | null`. The fallback is the shop picture, set only when `source` is `laststicker`.
  - `export const SCAN_RETRY_MS = 7 * 24 * 60 * 60 * 1000`.
  - `catalogManager.referenceCatalog(collection, now = Date.now())` picks one picture per card:
    - A manual card: `referenceImageUrl`, else `shopImageUrl` (source `shop`), else `no_picture`.
    - A laststicker card: `laststickerImageUrl` (source `laststicker`), unless `laststickerScanMissingAt` is within `SCAN_RETRY_MS`. Otherwise `shopImageUrl` (source `shop`), else `no_picture`.
    - The placeholder and shared rules apply to the chosen URL.
  - `catalogManager.markScanMissing(collection, cardId, now): void`.
  - `catalogManager.updateShopPictures(collection, entries): CardId[]` replaces `updateReferences`:
    - It writes `shopImageUrl` for every known card, manual cards included; an entry without a picture keeps the stored one.
    - It returns the cards whose chosen reference URL changed (read through `referenceCatalog` before and after).
  - `SyncResult` gains `repictured: readonly CardId[]`: laststicker cards whose stored scan URL changed. A changed URL also clears `laststickerScanMissingAt`.
  - `report()` in `sync.ts` calls `listingManager.rematchMismatches(collection, result.repictured)`. A failure there is logged, like `markSyncSuccess`.
  - In `runner.ts` `checkShop`, the `adapter.id === 'sammel-ente'` branch becomes `COLLECTIONS`' definition of `adapter.collection`, with `referenceFallbackShop === adapter.id`. It calls `updateShopPictures` and then `rematchMismatches`.

- [ ] **Step 1: Failing tests** in `catalogManager.test.ts`:
  - `referenceCatalog uses the laststicker scan, with the shop picture as fallbackUrl` → `{cardId:'1', referenceImageUrl:'https://www.laststicker.com/i/cards/12125/1.jpg', source:'laststicker', fallbackUrl:'https://shop-sammel-ente.de/1.jpg'}`.
  - `a scan missing within SCAN_RETRY_MS gives the shop picture; after it the scan again`: `markScanMissing` at t. At t + 1 the source is `shop`. At t + `SCAN_RETRY_MS` it is `laststicker`.
  - `a manual card keeps the admin's picture over the shop's, uses the shop's without one, and is no_picture without both` (Review Focus 3).
  - `updateShopPictures returns only cards whose chosen reference changed`:
    - A shop picture for a card on its scan → `[]`.
    - The same for a card whose scan is missing → `[id]`.
  - `syncCollection reports repictured cards and clears their missing mark`.
  - Change the existing `updateReferences` tests to `updateShopPictures`, with the same cases.
- [ ] **Step 2: Failing tests** elsewhere:
  - `sync.test.ts`: `a sync that changed scans compares those cards' mismatches again`. Spy on `listingManager.rematchMismatches` with the `repictured` ids.
  - `runner.test.ts`: the existing sammel-ente reference tests now assert `shopImageUrl` through `referenceCatalog(...).usable[].fallbackUrl` / source `shop`.
- [ ] **Step 3: Run.** `./bin/mise run test src/bot/database/catalogManager.test.ts src/bot/catalog/sync.test.ts src/bot/check/runner.test.ts`. Expected: FAIL.
- [ ] **Step 4: Implement** the Produces list. `getCard` keeps returning `referenceImageUrl`, now the admin's picture only; its comment says so.
- [ ] **Step 5: Run** those tests plus the whole suite (`./bin/mise run test`). Expected: PASS. Adapt only tests that wrote sammel-ente pictures through `updateReferences` and read them back as references.
- [ ] **Step 6: Commit** `feat(cards): pick each card's reference by source, laststicker first`

### Task 4: 404 fallback in the reference loader, and paced laststicker downloads

**Files:**

- Create: `src/bot/utils/pacedFetch.ts`, `pacedFetch.test.ts`
- Modify: `src/bot/matcher/embedder.ts`, `embedder.test.ts`
- Modify: `src/bot/check/runner.ts`, `runner.test.ts`
- Modify: `src/bot/bot.ts` (wiring only)

**Interfaces:**

- Consumes: `ReferenceCard.fallbackUrl` and `source` (Task 3), `catalogManager.markScanMissing`.
- Produces:
  - `createPacedFetch(fetchFn: FetchFn, hosts: ReadonlySet<string>, delayMs: number, deps?: { now?: () => number; sleep?: (ms: number) => Promise<void> }): FetchFn`.
    - A request to one of `hosts` waits until `delayMs` has passed since the previous one to those hosts.
    - Requests are serialized through one queue. Other hosts pass through unchanged.
  - `LAST_STICKER_HOST = 'www.laststicker.com'`, added to `IMAGE_HOSTS`.
  - `LoadReferenceOptions.onScanMissing?: (cardId: CardId) => void`.
    - When a reference with a `fallbackUrl` fails with an `ImageUnavailableError` whose `cause` is an `HttpError` with status 404 or 410, call `onScanMissing` and embed `fallbackUrl` instead.
    - Any other failure stays as today.
  - `loadReferenceSet` returns `LoadedReferenceSet` (exported from `embedder.ts`), which is `ReferenceSet & { urls: ReadonlyMap<CardId, string> }`: the URL each vector was embedded from. `ReferenceSet` in `identify.ts` stays as it is.
  - Runner, `collectionReferences`:
    - `referenceOf(id)` answers from the loaded set's `urls` when there is an embedder. It awaits `references()` before the first `matchListing` of that collection, so the title card is compared with the same picture as the set.
    - Without an embedder it answers from the catalog.
    - `onScanMissing` calls `catalogManager.markScanMissing(collection, id, deps.now())`.
  - `bot.ts` wraps `fetch` once with `createPacedFetch(fetch, new Set([LAST_STICKER_HOST]), 1500)`. It passes that to `createTransformersEmbedder` (`deps.fetchFn`) and to the notification picture download.

- [ ] **Step 1: Failing tests**
  - `pacedFetch.test.ts`:
    - `waits delayMs between two requests to a paced host`: fake clock; the second call sleeps 1500.
    - `does not pace other hosts`.
    - `serializes concurrent calls`: four parallel calls give three sleeps.
  - `embedder.test.ts`:
    - `a 404 scan falls back to the shop picture and reports the card` → the vector comes from the fallback, `urls.get(id)` is the fallback, `onScanMissing` was called once with the id, and `missing` is `[]`.
    - `a 500 or a timeout on a scan never falls back` → `image_unavailable` in `missing`, `onScanMissing` not called (Review Focus 2).
    - `a 404 without fallbackUrl stays image_unavailable`.
  - `runner.test.ts`: `a missing scan is recorded and the title card is compared with the fallback in the same run` (Review Focus 1). A stub embedder throws 404 for the scan URL. Expect `markScanMissing` to have happened (`referenceCatalog` now gives source `shop`), the listing `confirmed`, and no `reference-unavailable` alert.
- [ ] **Step 2: Run.** `./bin/mise run test src/bot/utils/pacedFetch.test.ts src/bot/matcher/embedder.test.ts src/bot/check/runner.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the Produces list.
- [ ] **Step 4: Run** those tests plus `./bin/mise run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(matcher): fall back to the shop picture when a laststicker scan is missing`

### Task 5: sammel-ente listings are compared like any shop's

**Files:**

- Modify:
  - `src/bot/matcher/matchStatus.ts` (+ test)
  - `src/bot/matcher/embedder.ts` (+ test)
  - `src/bot/database/listingManager.ts` (+ test)
  - `src/bot/notify/messages.ts` (+ test)
  - `src/bot/commands/shopCell.ts` (+ test)
  - `src/bot/check/runner.ts` (`needsMatch` `satisfies` list)
  - `src/test/listings.ts`

**Interfaces:**

- Produces:
  - `MATCH_STATUSES` without `reference`; the doc comment loses that line.
  - `defaultMatchStatus(shop, cardIds)` → `bundle` for more than one card, else `pending`, for every shop.
  - `matchListing` has no sammel-ente branch.
  - `shopCell`'s confirmed check is `matchStatus === 'confirmed'`.
  - The test helper's default status is `pending`.

- [ ] **Step 1: Failing tests**
  - `listingManager.test.ts`: `a new sammel-ente single-card listing starts pending`.
  - `embedder.test.ts`: `a sammel-ente listing is compared with the reference` → `confirmed` with a similarity.
  - Replace the tests that expected `reference` with these.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Remove `reference` and let `typecheck` find every use: the `messages.ts` footer case, `shopCell`, `runner.ts`'s `satisfies`, `embedder.ts`'s `plain` type.
- [ ] **Step 4: Run** `./bin/mise run typecheck` and `./bin/mise run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shops): compare sammel-ente listings like every other shop's`

### Task 6: The one-time re-match with one summary

**Files:**

- Modify: `src/bot/database/schema/listings.ts`
- Create (generated): `src/bot/database/migrations/0008_*.sql`
- Modify:
  - `src/bot/database/db.test.ts`
  - `src/bot/database/listingManager.ts` (+ test)
  - `src/bot/check/runner.ts` (+ test)
  - `src/bot/commands/admin.ts` (`formatSummary`, + test)

**Interfaces:**

- Consumes: Task 5's statuses.
- Produces:
  - `listings.rematchFrom: text | null`: the status before the reference switch, until the listing is compared again. `StoredListing.rematchFrom: string | null`.
  - Migration SQL, after the generated `ALTER`:
    ```sql
    UPDATE `listings` SET `match_status` = 'confirmed' WHERE `match_status` = 'reference' AND `manual_override` = 1;
    UPDATE `listings` SET `rematch_from` = `match_status`, `match_status` = 'pending', `similarity` = NULL, `match_checked_at` = NULL, `picture_card_id` = NULL WHERE `manual_override` = 0 AND `match_status` <> 'bundle';
    ```
  - `listingManager.finishRematch(listingId: number, mismatchNotedAt: number | null): void` clears `rematchFrom`. When `mismatchNotedAt` is given it also sets `mismatchNotedAt`, so that mismatch gets no note of its own.
  - `RunSummary.rematch?: { compared: number; changed: number; changes: readonly string[] }`. `changes` holds at most 10 lines `#<card> <shop> <old>→<new> <url>`.
  - In `matchPending`, after `setMatch`, for a listing with `rematchFrom !== null` and a result other than `image_unavailable` or `model_unavailable`:
    - Count it as compared.
    - It changed unless the old and new status are equal; `reference` counts as `confirmed`.
    - Call `finishRematch(l.id, result.status === 'mismatch' ? deps.now() : null)`.
  - After the loop, when `changed > 0`, send one alert with key `rematch-summary`:
    - Text: `Reference switch: compared <compared> listing(s) again, <changed> changed: <changes joined "; ">`.
    - New mismatches are not sent to users and get no note of their own.
    - Clip the text with `DISCORD_MESSAGE_LIMIT`.
  - `formatSummary` adds the line `re-match: <compared> compared, <changed> changed` when `rematch` is set.

- [ ] **Step 1: Failing tests**
  - `db.test.ts`: `migration 0008 resets unmapped listings once and keeps the admin's and bundles` (Review Focus 5). Store an unmapped `confirmed`, an unmapped `reference`, a mapped `reference`, a mapped `confirmed` and a `bundle`. Expect:
    - pending/`confirmed` and pending/`reference`, with the old status in `rematch_from`;
    - the mapped `reference` becomes `confirmed`;
    - the mapped `confirmed` and the `bundle` are unchanged, with `rematch_from` null.
  - `runner.test.ts`:
    - `the re-match sends one summary instead of a note per mismatch`: two listings with `rematchFrom` `confirmed`; one result is `mismatch`, one `confirmed`. Expect one `rematch-summary` alert naming one change, no `mismatch:` alert, and `rematchFrom` null on both.
    - `a listing that cannot be compared keeps rematchFrom`: an `image_unavailable` result.
    - `an available listing notified before the reset is not notified again` (Review Focus 4): record a notification, reset with the 0008 UPDATE, and run.
  - `admin.test.ts`: `formatSummary names the re-match counts`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement:** schema, `db:generate`, hand-append the two UPDATEs (each after a `--> statement-breakpoint`), then the Produces list.
- [ ] **Step 4: Run** `./bin/mise run test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(matcher): compare every listing once against the new references, with one summary`

### Task 7: Docs

**Files:**

- Modify: `docs/image-matching.md`, `docs/shops.md`, `docs/deployment.md`, `CLAUDE.md`, the spec ("Notes from PR 2b")

- [ ] **Step 1: Update the docs**
  - `image-matching.md`:
    - The reference source rule: admin picture / scan / shop fallback, the 404 mark and the 7-day retry.
    - `reference` is gone from the statuses.
    - The re-match and its summary.
  - `deployment.md`: the first run after the deploy downloads about 251 scans at 1.5 s each (about 6 to 7 minutes) before its DMs.
  - `CLAUDE.md`:
    - The decision "The sammel-ente listing picture of the same card number is the image reference" becomes "The laststicker scan is the image reference, sammel-ente's picture the fallback when the scan answers 404 (`referenceFallbackShop`)".
    - The match statuses line drops "of shops other than sammel-ente".
    - The shop request line adds that laststicker pictures are paced too.
  - Spec "Notes from PR 2b":
    - `reference_source` is derived (`ReferenceCard.source`), not stored.
    - The re-match keeps the old status in `rematch_from`.
- [ ] **Step 2: Check.** Run `./bin/mise run format:check`. Expected: clean.
- [ ] **Step 3: Commit** `docs: describe laststicker scans as the reference`
