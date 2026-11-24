# Collections PR 2a: laststicker catalog and manual cards — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `lego-minecraft-3` catalog (card list, names, kinds, variants, puzzle flag) comes
from laststicker, synced once a day and on `/admin catalog sync`. The admin can add, edit,
remove and release cards laststicker lacks. Reference pictures and matching do not change yet.

**Architecture:** `src/bot/catalog/laststicker.ts` fetches and parses one laststicker set page.
`catalogManager.syncCollection` applies the rows (never deletes, never touches manual cards).
`src/bot/catalog/sync.ts` decides when a collection is due, runs the sync, and alerts. The
runner calls it before the shops. `/admin catalog` gets `sync`, `add`, `edit`, `remove` and
`release`.

**Tech Stack:** Bun, TypeScript, cheerio, Drizzle ORM on SQLite, discord.js, `bun test`, Mise.

**Spec:** `docs/superpowers/specs/2026-11-19-multi-collection-design.md`, sections "Catalog from
laststicker", "Cards laststicker is missing", "Names and reference pictures" and "Notes from PR 1
for the later steps". This is rollout step 2, split in two (see the rulings below).

## Builder's rulings (the maintainer handed the how to the builder)

- **Step 2 is split.** PR 2a (this plan) syncs the catalog and adds manual cards. Reference
  pictures stay sammel-ente's. PR 2b measures the threshold on laststicker scans, switches the
  references (with the sammel-ente fallback), compares sammel-ente listings like any shop, drops
  `reference` and runs the one-time re-match. Why: the threshold measurement can stop the switch
  (spec), and the catalog must not wait for it. PR 2a stores each card's laststicker picture URL
  (`cards.laststicker_image_url`), so PR 2b can measure without new scraping code.
- **Names come from laststicker in PR 2a.** On 2026-11-24, laststicker and sammel-ente gave the
  same name for every series 3 card in the fixtures (English names, even on `/de/`). sammel-ente's
  run stops writing names and puzzle flags; it still writes reference pictures until PR 2b.
- **Puzzle cards** are the rows of laststicker's section `Puzzlekarten` (the spec said
  `Puzzlekarte`; the live page says `Puzzlekarten`). The name rule ("Puzzlekarte" in the name)
  goes. Migration 0006 sets `puzzle_seen` on every stored name with "Puzzlekarte" first, so no
  puzzle card loses its mark when laststicker renames it ("The Overworld 1").
- **When a sync runs:** from the check run, before the shops, when the collection's last attempt
  is 24 h old or older (`catalog_syncs.attempted_at`; none yet counts as due). A failed sync is
  retried after 24 h too, not every hour. `/admin catalog sync` runs it now. The starter catalog
  (`seedIfEmpty`) still seeds an empty catalog at start, so the bot works offline.
- **"Now on laststicker" is noted once** per manual card (`cards.listed_noted_at`), as the spec
  asks. Vanished cards are noted through a throttled alert (once a day while they stay vanished).

## Facts from the live page (fetched 2026-11-24 with the bot User-Agent)

- URL: `https://www.laststicker.com/de/cards/blue_ocean_lego_minecraft_on_fire/` (robots.txt
  allows `/de/cards/<set>/`). Set id `12125`, from `<div class="cards_tooltip cards_info"
rel="tooltip12125">` around the table.
- Table `#checklist`, `<tbody>` rows of 8 cells: number, title (`<a>` name; puzzle rows append
  `<div><div class="pz"></div>1</div>`), section (`Bereich`), type (`Typ`), then four counts.
- 251 rows: `1`-`228`, `LE1`-`LE22`, `XXL1`. Sections: Characterkarten 153, Puzzlekarten 36,
  Limited Edition 22, Comic-Karten 21, Setkarten 18, Oversize Karte 1. Types: Basis Karte 176,
  Holofilie Karte 32, Limitierte Karte 22, Ultra Karte 12, Lava Karte 8, Limitierte XXL Karte 1.
- Samples: `1` Alex / Characterkarten / Basis Karte; `104` Ghast / Characterkarten / Lava Karte;
  `154` The Overworld + piece `1` / Puzzlekarten / Basis Karte; `LE10` Exploding Creeper /
  Limited Edition / Limitierte Karte; `XXL1` Charged Creeper / Oversize Karte / Limitierte XXL
  Karte.
- Pictures: `https://www.laststicker.com/i/cards/12125/<lowercase id>.jpg`. `1`, `131`, `le1`
  and `154` answer 200; `LE1` (uppercase) and `xxl1` answer 404 (XXL1 has no scan).

## Global Constraints

- Every task runs through `./bin/mise run <task>` (`test`, `typecheck`, `lint`, `format`,
  `format:check`, `db:generate`); never `bun run`, `npm` or `npx` directly.
- Every non-test source file in `src/` has a `*.test.ts` beside it. A file of types only has no
  coverage data and fails CI's new-file coverage gate (80 %): keep types in a file with code.
- Conventional Commits, scopes `bot`, `cards`, `database`, `shops`, `ebay`, `matcher`, `notify`,
  `commands`, `admin`, `ci`, `docs`, `docker`; `git commit -s`; the message ends with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never `--no-verify`.
- laststicker requests use `fetchText` (User-Agent `minecraft-cards-bot/1.0 (+hourly stock
check)`, 20 s timeout) and 1500 ms between two requests to the host. The bot requests only
  `/de/cards/<set>/` pages; never `/cards/*/checklist`, `/cards/preview/`, `/cards/s1/`,
  `/cards/s2/` or `/de/rules`.
- Timestamps are integer epoch milliseconds. Card ids go through `normalizeCardId`.
- laststicker values in errors and admin texts are clipped to 200 characters; admin texts to
  Discord's 2000 (`clipText`).
- Validate every URL with `validUrl` (`notify/messages.ts`) before it is stored as a picture or
  reaches a discord.js builder.
- A sync that fails (HTTP error, timeout, layout) changes nothing.
- Branch from a freshly fetched `origin/main`. Run the pr-review-toolkit on the PR before
  handing it over, and again after substantial fixes; fix every finding.

## Review Focus

- A laststicker answer without the table (Cloudflare, maintenance), with a row that does not
  parse, or with a number the id rule rejects: `CatalogLayoutError`, nothing changes, the run
  goes on, and one throttled alert names it. Test: Task 1 (parser) and Task 4 (sync).
- A table with fewer cards than stored (a partial page): the missing cards are kept, still on
  every missing list, reported as vanished; nothing is deleted. Test: Task 3.
- A manual card that laststicker later lists keeps its name and picture, and the admin is told
  exactly once. Test: Task 3 and Task 4.
- Removing a manual card that users have on their lists: the confirm names how many users have
  it; Cancel, an expired token or another user's press removes nothing. Test: Task 5.
- A puzzle card renamed by laststicker ("Puzzlekarte Oberwelt 1" to "The Overworld 1") stays a
  puzzle card (migration backfill, then `Puzzlekarten`). Test: Task 2 and Task 3.

---

### Task 1: laststicker page parser and fetch

**Files:**

- Create: `src/bot/catalog/laststicker.ts`, `src/bot/catalog/laststicker.test.ts`
- Create: `src/test/fixtures/laststicker-lego-minecraft-3.html`
- Modify: `src/bot/collections/ids.ts` (definition field), `src/bot/collections/legoMinecraft3.ts`,
  their tests

**Interfaces:**

- Produces:
  - `CollectionDefinition.laststicker?: { readonly set: string }`; `legoMinecraft3.laststicker`
    is `{ set: 'blue_ocean_lego_minecraft_on_fire' }`.
  - `class CatalogLayoutError extends Error` (`name` `'CatalogLayoutError'`).
  - `interface LaststickerRow { cardId: CardId; name: string; kind: string; variant: string;
pictureUrl: string }`.
  - `parseLaststickerPage(html: string): { setId: number; rows: LaststickerRow[] }`.
  - `laststickerSetUrl(set: string): string` gives `https://www.laststicker.com/de/cards/<set>/`.
  - `fetchLaststickerSet(set: string, fetchFn?: FetchFn): Promise<{ setId: number; rows:
LaststickerRow[] }>` (one `fetchText`, then the parser).

- [ ] **Step 1: Make the fixture.** Fetch the URL above once with the bot User-Agent. Keep the
      `cards_tooltip` div, the whole `#checklist` table and the closing tags, and drop the rest
      of the page. Note the date in an HTML comment at the top.
- [ ] **Step 2: Write the failing tests** in `laststicker.test.ts`:
  - The fixture gives `setId` 12125 and 251 rows, in page order (first `1`, then `228`, `LE1`,
    last `XXL1`).
  - `1` is `{ name: 'Alex', kind: 'Characterkarten', variant: 'Basis Karte', pictureUrl:
'https://www.laststicker.com/i/cards/12125/1.jpg' }`.
  - `154` is named `The Overworld 1` with kind `Puzzlekarten`.
  - `LE10` has picture URL `…/12125/le10.jpg`, and `XXL1` has `…/12125/xxl1.jpg`.
  - Names are trimmed and HTML-decoded (an `&amp;` in a cell is `&`).
  - `CatalogLayoutError` for each of these, with a message naming the problem:
    - no `#checklist`;
    - no rows;
    - a row with fewer than 4 cells;
    - a number `normalizeCardId` rejects (the message carries the value, clipped to 200);
    - a duplicate number;
    - an empty name;
    - no `rel="tooltip<digits>"`.
  - `fetchLaststickerSet` requests exactly `laststickerSetUrl(set)` with the bot User-Agent, and
    an HTTP 503 rejects with `HttpError`.
  - `legoMinecraft3.laststicker.set` is `blue_ocean_lego_minecraft_on_fire`.
- [ ] **Step 3: Run** `./bin/mise run test src/bot/catalog src/bot/collections`. Expected: FAIL
      (module missing).
- [ ] **Step 4: Implement.** Parse with cheerio, in the style of `shops/sammelEnte.ts`.
  - The puzzle piece is the text of the title cell's nested `div` after the `.pz` div, joined to
    the name with one space.
  - The picture id is `cardId.toLowerCase()`.
- [ ] **Step 5: Run** the same tests and `./bin/mise run typecheck`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(cards): read a laststicker set page`.

### Task 2: Schema and migration 0006

**Files:**

- Modify: `src/bot/database/schema/cards.ts`. Create `src/bot/database/schema/catalogSyncs.ts`
  and export it from `schema/index.ts`.
- Create (generated, then edited): `src/bot/database/migrations/0006_*.sql` and `meta/`
- Test: `src/bot/database/db.test.ts`

**Interfaces:**

- Produces:
  - `CARD_SOURCES = ['laststicker', 'manual'] as const` and `type CardSource`, in
    `src/bot/collections/ids.ts` (the schema imports ids only).
  - `cards` gains these columns:
    - `kind: text()` and `variant: text()`, both nullable;
    - `source: text({ enum: CARD_SOURCES }).notNull().default('laststicker')`;
    - `laststickerImageUrl: text()`;
    - `listedNotedAt: integer()`.
  - New table `catalog_syncs`: `collection` (primary key, enum `COLLECTION_IDS`),
    `attemptedAt: integer().notNull()`, `succeededAt: integer()`.

- [ ] **Step 1: Write the failing test.** In `db.test.ts`, extend the round-trip test: a card
      with kind, variant, `source` `manual` and `laststickerImageUrl`, and a `catalog_syncs`
      row. Add a migration test in the style of the 0005 one:
  - Run migrations up to 0005 through the migrator.
  - Store cards named `Puzzlekarte Oberwelt 1` (`puzzle_seen` 0) and `Squid`.
  - Apply 0006.
  - Assert the puzzle row now has `puzzle_seen` 1, `Squid` keeps 0, and both have `source`
    `laststicker`.
- [ ] **Step 2: Run** `./bin/mise run test src/bot/database/db.test.ts`. Expected: FAIL.
- [ ] **Step 3: Edit the schema,** then run `./bin/mise run db:generate`.
  - Append to the generated SQL:
    ``UPDATE `cards` SET `puzzle_seen` = 1 WHERE `name` LIKE '%Puzzlekarte%';``
  - Add a leading comment saying it is hand-edited and why, as 0005 does.
- [ ] **Step 4: Run** the test. Expected: PASS. Then run `./bin/mise run db:generate` again.
      Expected: "No schema changes".
- [ ] **Step 5: Commit** `feat(database): store laststicker kinds, card sources and sync times`.

### Task 3: Catalog manager: sync and manual cards

**Files:**

- Modify: `src/bot/database/catalogManager.ts` and its test
- Modify: `src/bot/check/runner.ts` (sammel-ente call), `src/bot/check/runner.test.ts`

**Interfaces:**

- Consumes: `LaststickerRow` (Task 1); the schema (Task 2).
- Produces:
  - `interface SyncResult { added: CardId[]; renamed: CardId[]; vanished: CardId[]; nowListed:
CardId[] }`. All lists are sorted.
    - `nowListed` holds manual cards the rows contain whose `listedNotedAt` was null. The sync
      sets it in the same transaction.
  - `catalogManager.syncCollection(collection, rows: readonly LaststickerRow[], now): SyncResult`.
    It runs in one transaction:
    - It inserts missing ids as `laststicker` cards.
    - For `laststicker` cards it sets name, kind, variant and `laststickerImageUrl`, plus
      `puzzleSeen = true` when kind is `Puzzlekarten`. It never clears `puzzleSeen`.
    - `renamed` lists the cards whose stored non-null name changed.
    - It never deletes a card, and it never changes a `manual` card.
    - `vanished` lists the `laststicker` cards the rows lack.
  - `catalogManager.updateReferences(collection, entries: { cardId; imageUrl: string | null
}[]): CardId[]`. It replaces `updateNamesAndReferences`, and the runner's sammel-ente branch
    calls it. It keeps the old rules: a null picture keeps the stored one, unknown ids are
    skipped, and it returns the cards whose reference URL changed. It writes no name and no
    puzzle flag, and it skips `manual` cards.
  - `CatalogCard` gains `kind: string | null`, `variant: string | null` and `source:
CardSource`. `puzzle` becomes `puzzleSeen` alone; `isPuzzleCardName` goes.
  - Manual cards. Each function returns a result with a reason, so the command can name it:
    - `addManual(collection, cardId, name, pictureUrl: string | null, now)` gives
      `{ ok: true } | { ok: false; reason: 'exists' }`.
    - `editManual(collection, cardId, { name?, pictureUrl? }, now)`,
      `releaseManual(collection, cardId, now)` and `removeManual(collection, cardId)` each give
      `{ ok: true } | { ok: false; reason: 'unknown' | 'not_manual' }`.
    - `wantedCount(collection, cardId): number`.
    - `addManual` stores `source` `manual`, `type` from `cardType`, and `referenceImageUrl` =
      `pictureUrl`.
    - `releaseManual` sets `source` `laststicker` and `listedNotedAt` null.
    - `removeManual` deletes the card row only; wanted lists keep the id, as `applyImport` does.

- [ ] **Step 1: Write the failing tests** in `catalogManager.test.ts`, with rows built by a
      `row(id, name, kind = 'Characterkarten')` helper:
  - A first sync over the starter catalog adds nothing and sets the names, kinds and pictures.
  - A new id is added.
  - A rename is listed in `renamed`.
  - Rows lacking a stored card list it in `vanished` and keep it. `knownIds` is unchanged and
    `wantedCards` is unchanged.
  - `Puzzlekarten` sets `puzzle`. A later sync with another kind keeps it.
  - A manual card listed by the rows keeps its name and picture, is in `nowListed` once, and is
    not listed on the next sync.
  - Another collection's cards are untouched (`OTHER`, as in PR 1).
  - `updateReferences` writes no name and skips a manual card.
  - Manual cards: `addManual` refuses an existing id (`exists`). `editManual` and `removeManual`
    on a laststicker card give `not_manual`, and on an unknown id give `unknown`. `wantedCount`
    counts users.
  - Adapt the existing puzzle-by-name tests to the sticky flag: a name alone no longer makes a
    puzzle card.
- [ ] **Step 2: Run** `./bin/mise run test src/bot/database src/bot/check`. Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces.
- [ ] **Step 4: Run** the same tests and `./bin/mise run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cards): sync the catalog and keep manual cards`.

### Task 4: Daily sync in the check run

**Files:**

- Create: `src/bot/catalog/sync.ts`, `src/bot/catalog/sync.test.ts`
- Modify: `src/bot/check/runner.ts` (`RunDeps`, `runCheck`), `src/bot/check/runner.test.ts`,
  `src/bot/bot.ts`

**Interfaces:**

- Consumes: `fetchLaststickerSet` (Task 1); `syncCollection` (Task 3); `catalog_syncs` (Task 2);
  `AlertFn` (`check/adminAlert.ts`); `collectionName`.
- Produces:
  - `SYNC_EVERY_MS = 24 * 60 * 60 * 1000`.
  - `type SyncOutcome = { collection: CollectionId } & ({ ok: true; result: SyncResult } | { ok:
false; error: string })`.
  - `catalogManager.syncAttemptedAt(collection): number | undefined`,
    `markSyncAttempt(collection, now)` and `markSyncSuccess(collection, now)` (upserts on
    `catalog_syncs`, in `catalogManager.ts` with their tests).
  - `syncCatalogs(deps: { now: () => number; alert: AlertFn; fetchSet?: typeof
fetchLaststickerSet; sleep?: (ms: number) => Promise<void>; collections?: readonly
CollectionDefinition[]; only?: CollectionId; force?: boolean }): Promise<SyncOutcome[]>`
    (`collections` defaults to `COLLECTIONS`).
    - It covers every collection with `laststicker` (or only `only`) that is due, or every one
      when `force` is set.
    - It waits 1500 ms between two collections, records `attemptedAt` before the fetch and
      `succeededAt` after the sync, and never rejects.
  - The alerts, each clipped to 2000:
    - a failure is `catalog-sync:<collection>`, `Catalog sync of <name> failed, nothing
changed: <error>`;
    - `vanished` is `catalog-vanished:<collection>`, `<name>: <n> card(s) no longer on
laststicker, kept: <ids>`;
    - `nowListed` is `catalog-listed:<collection>:<ids>`, `<name>: manual card(s) now on
laststicker: <ids> — /admin catalog release hands one over`.
  - `formatSyncOutcome(o: SyncOutcome): string` gives the line used in the `/admin catalog
sync` reply.
  - `RunDeps.syncCatalogs?: () => Promise<unknown>`. `runCheck` calls it first in the
    wanted-cards branch, before the shops, inside its own try/catch. A rejection is logged and
    the run goes on. `bot.ts` passes `() => syncCatalogs({ now: Date.now, alert })`, using the
    run's throttled alert.

- [ ] **Step 1: Write the failing tests** in `sync.test.ts`, with a fake `fetchSet` and a
      recorded `sleep`:
  - A collection without a row is due and synced. One synced 23 h ago is not due. 24 h ago it
    is.
  - `force` syncs anyway.
  - A failing fetch (`HttpError`, `CatalogLayoutError`) changes no card, records `attemptedAt`
    but not `succeededAt`, alerts once with the key `catalog-sync:lego-minecraft-3`, and
    resolves.
  - Vanished and now-listed cards send their alerts with the keys above.
  - With `collections` set to two definitions that both have `laststicker`, the second is
    synced after `sleep(1500)`. Use `lego-minecraft-3` and an `OTHER` definition cast as in
    PR 1.
  - In `runner.test.ts`:
    - `syncCatalogs` runs before the first shop fetch.
    - A `syncCatalogs` that rejects still leaves the shops checked.
    - There is no call when nobody wants a card, the same rule as for the shops.
- [ ] **Step 2: Run** `./bin/mise run test src/bot/catalog src/bot/check`. Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces.
- [ ] **Step 4: Run** the same tests and `./bin/mise run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cards): sync each catalog from laststicker once a day`.

### Task 5: `/admin catalog sync|add|edit|remove|release`

**Files:**

- Modify: `src/bot/commands/admin.ts` and its test, `src/bot/interactions/router.ts` and its test
- Create: `src/bot/interactions/catalogRemove.ts`, `src/bot/interactions/catalogRemove.test.ts`
- Modify: `src/bot/bot.ts` (the `sync` dependency in `AdminContext`)

**Interfaces:**

- Consumes: Tasks 3 and 4; `collectionOption`, `readCollection`, `UNKNOWN_COLLECTION`;
  `normalizeCardId`; `validUrl`.
- Produces:
  - `AdminContext.syncCatalog: (collection: CollectionId) => Promise<SyncOutcome[]>`. `bot.ts`
    passes `(c) => syncCatalogs({ now: Date.now, alert, only: c, force: true })`.
  - The new subcommands of the `catalog` group. Each takes `collection` first (required); the
    other options come after, in this order:
    - `sync`;
    - `add` with `card` and `name` (required), `picture` (optional);
    - `edit` with `card` (required), `name` and `picture` (optional);
    - `remove` with `card`;
    - `release` with `card`.
  - The replies, all ephemeral:
    - `sync` defers, then edits in `formatSyncOutcome`.
    - `add` gives `Added #<id> <name> to <collection name> (manual).`. An existing id gives
      `#<id> is already in <collection name>.`. An invalid id gives `Not a card number: <token>`.
      A picture that fails `validUrl` gives `Not a valid picture URL.`.
    - `edit` with neither option gives `Nothing to change: give name or picture.`.
    - For `not_manual`: `#<id> comes from laststicker; only manual cards can be changed here.`.
      For `unknown`: `No card #<id> in <collection name>.`.
    - `remove` answers `Remove manual card #<id> <name>? <n> user(s) have it on their missing
list.` with buttons `catalog-remove:<token>` (Remove, danger) and `catalog-keep:<token>`.
      The token store holds `{ collection, cardId }` for 10 minutes, as `createImportStore`
      does. On Remove it calls `removeManual` and answers `Removed #<id>.`. Keep and an expired
      token remove nothing. Only `BOT_ADMIN_ID` may press.
    - `release` gives `#<id> now follows laststicker from the next sync.`.
  - Router: the prefixes `catalog-remove:` and `catalog-keep:` route to `handleCatalogRemove`.

- [ ] **Step 1: Write the failing tests** in `admin.test.ts` (builder JSON and each reply above)
      and `catalogRemove.test.ts`:
  - A remove with 2 wanting users names `2 user(s)`.
  - Remove deletes the card. Keep, an expired token and a non-admin press do not.
  - Pressing Remove twice removes once.
  - A router test for the two prefixes.
- [ ] **Step 2: Run** `./bin/mise run test src/bot/commands src/bot/interactions`. Expected:
      FAIL.
- [ ] **Step 3: Implement** the Interfaces.
- [ ] **Step 4: Run** `./bin/mise run test`, `./bin/mise run typecheck`, `./bin/mise run lint` and
      `./bin/mise run format:check`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(admin): manage cards laststicker lacks`.

### Task 6: Docs, review, PR

**Files:**

- Modify:
  - `CLAUDE.md`: in Architecture, add `catalog/` (laststicker page, daily sync). In Decisions:
    - names, kinds and the card list come from laststicker;
    - puzzle cards are the section `Puzzlekarten`;
    - manual cards are never touched by the sync;
    - "The sammel-ente listing picture is the image reference" stays true until PR 2b.
  - `docs/image-matching.md` (the puzzle rule), `docs/shops.md` (sammel-ente writes only
    references), `docs/configuration.md` (if it lists admin commands), `README.md` (the
    `/admin catalog` subcommands).

- [ ] **Step 1:** Update the docs as listed, then run `./bin/mise run format:check`.
- [ ] **Step 2:** Commit `docs: describe the laststicker catalog and manual cards`.
- [ ] **Step 3:** Push and open the PR (`feat: laststicker catalog and manual cards`). Run
      `/pr-review-toolkit:review-pr` with code, tests, errors, comments and types. Fix every
      finding, then run it again after substantial fixes.
- [ ] **Step 4:** Hand it over for labels and merge. After the deploy:
  - The first check run syncs `lego-minecraft-3`, with no `catalog-sync` alert.
  - `/card collection:… number:154` still shows a puzzle card.
  - `/admin catalog sync` replies with 0 added and 0 vanished.
