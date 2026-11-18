# `/missing status` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/missing status`, showing each missing card's per-shop state and each shop's last check time and result.

**Architecture:** Read-only. New query methods (`runManager.latestReadable`, `runManager.lastSuccess`, `listingManager.listingsForCards`) and a pure formatter `buildStatusReply` in a new `src/bot/commands/missingStatus.ts`, wired as a subcommand in `missing.ts`.

**Tech Stack:** Bun, TypeScript, discord.js 14, Drizzle/bun:sqlite.

**Spec:** `docs/superpowers/specs/2026-11-18-missing-status-design.md`

## Global Constraints

- Follow the repo `CLAUDE.md`. Every task runs through `./bin/mise run`. Every new source file gets a `*.test.ts`.
- Commits are Conventional, made with `git commit -s` (signed), and carry the Co-Authored-By trailer. Scope `commands` or `database`.
- Replies are ephemeral and at most 2000 characters. Use `joinWithinLimit` / `DISCORD_MESSAGE_LIMIT` from `src/bot/utils/messageLimit.ts`.
- Timestamps are epoch ms. Discord times use `<t:unix:R>` only: relative, so stale data never reads as today's.
- Shop display names: `sammel-ente`, `blue-ocean`, `eBay`. Price format is the one the notifications use (reuse the existing formatter in `notify/messages.ts`; export it if it is not exported).

## Review Focus

- A shop that failed in the last run or was absent from it: its card entries must say "(as of …)" with the last successful check time, never pass as current; a card it has no listing of is "unknown", never "not listed".
- A listing that is available but on hold must not read "in stock".
- A user with many cards: the reply stays at most 2000 characters and ends with "… and N more cards".
- No run yet, or an empty list: a clear text, no crash.

---

### Task 1: Queries

**Files:** Modify `src/bot/database/runManager.ts` and `src/bot/database/listingManager.ts`, plus their tests.

**Interfaces:**

- Produces `runManager.latestReadable(): { summary: RunSummary | undefined; newerUnreadable: boolean }`: the newest readable run, and whether a newer (or, without one, any) row was unreadable.
- Produces `runManager.lastSuccess(shop: ShopId, now: number): number | undefined`. Returns `startedAt` of the newest run started within `LAST_SUCCESS_WINDOW_MS` (7 days) before `now` whose summary has an entry for `shop` without `error`. Uses `parseSummary`, so invalid rows are skipped; pages newest first, 50 rows at a time.
- `StoredListing` carries `lastSeenAt`.
- Produces `listingManager.listingsForCards(cardIds: CardId[]): StoredListing[]`. Returns every stored listing (any shop, available or not) whose `listing_cards` include any of the ids. One query plus the existing card-id loader; no N+1.

- [ ] Failing tests:
  - `lastSuccess`: runs where blue-ocean had an error, then success, then an error, return the success run's time.
  - `lastSuccess`: a shop that never appears returns `undefined`.
  - `listingsForCards(['12'])` returns both the sammel-ente and the blue-ocean listing of 12, and a bundle containing 12. It does not return a listing of 45.
- [ ] Implement, then run `./bin/mise run test src/bot/database`. Commit `feat(database): queries for /missing status`.

### Task 2: Formatter and subcommand

**Files:** Create `src/bot/commands/missingStatus.ts` and `missingStatus.test.ts`. Modify `src/bot/commands/missing.ts` and its test, plus `src/bot/commands/help.ts` (one line for `/missing status`) and its test if it asserts content.

**Interfaces:**

- Consumes `runManager.latestReadable()`, `runManager.lastSuccess`, `listingManager.listingsForCards`, `userManager.getList` and `catalogManager.getCard`.
- Produces a pure `buildStatusReply(input: { cards: CardId[]; latest: LatestRun; enabledShops: readonly ShopId[]; lastSuccess: Partial<Record<ShopId, number | null>>; listings: StoredListing[]; names: Map<CardId, string>; now: number }): string`. It is deterministic and does no database access. `lastSuccess` is filled exactly for the shops `needsLastSuccess(last, shop, enabledShops)` names (null: looked up, none in 7 days); a missing lookup throws.
- `missing.ts` exports `execute(interaction, { enabledShops })`; `bot.ts` passes the ids of the adapters it built.
- `missing.ts` gains a subcommand `status` (no options). It gathers the inputs and replies `{ content: buildStatusReply(...), flags: Ephemeral }`.

Rules (exact texts):

- Header: `Your missing cards (N) · last check <t:S:R>`, then `⚠️ The last check is older than <N> days; stock may have changed.` when `now - startedAt > LAST_SUCCESS_WINDOW_MS` (N from the constant), then `⚠️ The latest check record could not be read; showing the one before.` when a newer row was unreadable, then `❌ Last check failed: <error, cut to 100>` when the run has an error. With no run: `Your missing cards (N)` followed by the line `No check has run yet.`; with only unreadable rows: `⚠️ No readable check record.` and every card `unknown`.
- Shop lines, in the order sammel-ente, blue-ocean, eBay:
  - `✅ <name>: <n> listings`
  - `❌ <name>: error <t:S:R> – <error, cut to 100 chars>`
  - `⚠️ <name>: not checked` (enabled, absent from the run)
  - `⚪ <name>: not enabled` (no adapter built; its listings are not shown)
- Card line: `#12 Squid: sammel-ente 0,55 € in stock · blue-ocean sold out`.
  - Name omitted when unknown.
  - Per shop, the best listing: seen in the latest check beats not seen; then in stock beats held beats sold out or ended auction; then a `reference`/`confirmed` picture (a bundle never counts as one); then the lowest price (no price last).
  - Held: `paused (reported)`. An auction whose end is before `now`: `auction ended`. A bundle appends ` (bundle)`; a single-card listing without a `reference`/`confirmed` picture appends ` (picture unconfirmed)`. A listing of a successful shop that the latest check did not return appends ` (not seen in last check)`.
  - A shop whose last run entry has an error or is absent gets ` (as of <t:S:R>)` with `min(lastSuccess, listing.lastSeenAt)`, or ` (no successful check in <N> days)` (N from `LAST_SUCCESS_WINDOW_MS`).
  - Such a shop with no listing of the card: `<name> unknown (check failed)` / `<name> unknown (not checked)`.
  - `not listed in any shop` only when every enabled shop succeeded and none lists the card. With no run at all: `not checked yet`.
- Empty card list: `You have no missing cards on your list.`
- Overflow: keep whole card lines while the total fits in 2000 characters, then add `… and K more cards`. No hard cut: the head always fits.

- [ ] Failing tests for `buildStatusReply`, one per rule:
  - a normal reply;
  - a failed shop with "(as of)";
  - a failed shop without a success in the last 7 days;
  - held;
  - bundle;
  - best-listing choice;
  - not listed;
  - no run;
  - empty list;
  - 228 cards stay at most 2000 characters, with the right K;
  - an unknown name.
- [ ] A `missing.test.ts` case: `status` replies ephemerally and contains the header, using the real in-memory DB with one stored listing and one recorded run.
- [ ] Implement. `/help` gains a line for `/missing status`.
- [ ] Run the full gate (typecheck, lint, format:check, test:coverage, gitleaks). Commit `feat(commands): add /missing status`.

### Review fixes (PR #13)

The pr-review-toolkit findings changed the rules above to their final texts: unknown instead of
"not listed" for failed or unchecked shops, disabled shops, the 7-day success window, unreadable
run records, the failed-run line, picture and not-seen markers, the status error text
`Could not load your stock status. Please try again later.` (the log names the subcommand) and the
slash description `Your missing cards with what each shop last showed, and how fresh that is`.
