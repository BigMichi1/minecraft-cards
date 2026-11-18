# `/missing status` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/missing status`, showing each missing card's per-shop state and each shop's last check time and result.

**Architecture:** Read-only. Two new query methods (`runManager.lastSuccess`, `listingManager.listingsForCards`) and a pure formatter `buildStatusReply` in a new `src/bot/commands/missingStatus.ts`, wired as a subcommand in `missing.ts`.

**Tech Stack:** Bun, TypeScript, discord.js 14, Drizzle/bun:sqlite.

**Spec:** `docs/superpowers/specs/2026-11-18-missing-status-design.md`

## Global Constraints

- Follow the repo `CLAUDE.md`. Every task runs through `./bin/mise run`. Every new source file gets a `*.test.ts`.
- Commits are Conventional, made with `git commit -s` (signed), and carry the Co-Authored-By trailer. Scope `commands` or `database`.
- Replies are ephemeral and at most 2000 characters. Use `joinWithinLimit` / `DISCORD_MESSAGE_LIMIT` from `src/bot/utils/messageLimit.ts`.
- Timestamps are epoch ms. Discord times use `<t:unix:R>` or `<t:unix:t>`.
- Shop display names: `sammel-ente`, `blue-ocean`, `eBay`. Price format is the one the notifications use (reuse the existing formatter in `notify/messages.ts`; export it if it is not exported).

## Review Focus

- A shop that failed in the last run: its card entries must say "(as of …)" with the last successful check time, never pass as current.
- A listing that is available but on hold must not read "in stock".
- A user with many cards: the reply stays at most 2000 characters and ends with "… and N more cards".
- No run yet, or an empty list: a clear text, no crash.

---

### Task 1: Queries

**Files:** Modify `src/bot/database/runManager.ts` and `src/bot/database/listingManager.ts`, plus their tests.

**Interfaces:**

- Produces `runManager.lastSuccess(shop: ShopId): number | undefined`. Returns `startedAt` of the newest stored run whose summary has an entry for `shop` without `error`. Uses `parseSummary`, so invalid rows are skipped.
- Produces `listingManager.listingsForCards(cardIds: CardId[]): StoredListing[]`. Returns every stored listing (any shop, available or not) whose `listing_cards` include any of the ids. One query plus the existing card-id loader; no N+1.

- [ ] Failing tests:
  - `lastSuccess`: runs where blue-ocean had an error, then success, then an error, return the success run's time.
  - `lastSuccess`: a shop that never appears returns `undefined`.
  - `listingsForCards(['12'])` returns both the sammel-ente and the blue-ocean listing of 12, and a bundle containing 12. It does not return a listing of 45.
- [ ] Implement, then run `./bin/mise run test src/bot/database`. Commit `feat(database): queries for /missing status`.

### Task 2: Formatter and subcommand

**Files:** Create `src/bot/commands/missingStatus.ts` and `missingStatus.test.ts`. Modify `src/bot/commands/missing.ts` and its test, plus `src/bot/commands/help.ts` (one line for `/missing status`) and its test if it asserts content.

**Interfaces:**

- Consumes `runManager.last()`, `runManager.lastSuccess`, `listingManager.listingsForCards`, `userManager.getList`, `catalogManager.getCard` and `formatCardList`.
- Produces a pure `buildStatusReply(input: { cards: CardId[]; last: RunSummary | undefined; lastSuccess: Partial<Record<ShopId, number>>; listings: StoredListing[]; names: Map<CardId, string>; now: number }): string`. It is deterministic and does no database access.
- `missing.ts` gains a subcommand `status` (no options). It gathers the inputs and replies `{ content: buildStatusReply(...), flags: Ephemeral }`.

Rules (exact texts):

- Header: `Your missing cards (N) · last check <t:S:R>`. With no run: `Your missing cards (N)` followed by the line `No check has run yet.`
- Shop lines, in the order sammel-ente, blue-ocean, eBay:
  - `✅ <name>: <n> listings`
  - `❌ <name>: error at <t:S:t> – <error, cut to 100 chars>`
  - `⚠️ <name>: not checked`
- Card line: `#12 Squid: sammel-ente 0,55 € in stock · blue-ocean sold out`.
  - Name omitted when unknown.
  - Per shop, the best listing: available and not held beats held beats sold out, then the lowest price.
  - Held: `paused (reported)`. A bundle appends ` (bundle)`.
  - A shop whose last run entry has an error gets ` (as of <t:S:t>)` from `lastSuccess`. With no success at all it gets ` (never checked successfully)`.
  - No listings at all: `#12 Squid: not listed in any shop`. With no run at all: `not checked yet`.
- Empty card list: `You have no missing cards on your list.`
- Overflow: keep whole card lines while the total fits in 2000 characters, then add `… and K more cards`.

- [ ] Failing tests for `buildStatusReply`, one per rule:
  - a normal reply;
  - a failed shop with "(as of)";
  - a failed shop that was never successful;
  - held;
  - bundle;
  - best-listing choice;
  - not listed;
  - no run;
  - empty list;
  - 250 cards stay at most 2000 characters, with the right K;
  - an unknown name.
- [ ] A `missing.test.ts` case: `status` replies ephemerally and contains the header, using the real in-memory DB with one stored listing and one recorded run.
- [ ] Implement. `/help` gains a line for `/missing status`.
- [ ] Run the full gate (typecheck, lint, format:check, test:coverage, gitleaks). Commit `feat(commands): add /missing status`.
