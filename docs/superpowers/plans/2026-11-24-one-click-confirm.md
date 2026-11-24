# One-click Confirm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users flag an unconfirmed alert as right with one button; the admin confirms or dismisses listings with buttons instead of `/admin map` / `/admin clear`.

**Architecture:** A new `listingManager.confirmCards` does the `/admin map` writes with the listing's current cards but keeps `availableSince` (no re-notify). `interactions/adminActions.ts` owns the admin Confirm/Dismiss buttons and their handlers plus a shared listing embed; `interactions/right.ts` owns the user's Right button handler and its throttled admin DM. The router and `bot.ts` wire the three new customId prefixes.

**Tech Stack:** Bun, TypeScript, discord.js, Drizzle/SQLite, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-11-24-one-click-confirm-design.md`

> Amended after review: where this plan and the "Amended after review" section at its end disagree, the section and the code win.

## Global Constraints

- All tasks run through `./bin/mise run <task>` (`test`, `typecheck`, `lint`, `format`); never `bun run`/`npx` directly.
- Every new non-test file in `src/` gets a `*.test.ts` next to it.
- Commits: Conventional Commits, scopes from CLAUDE.md (`notify`, `admin`, `database`, `docs`), `git commit -s`, body ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never `--no-verify`.
- Timestamps are epoch ms; card ids canonical (`cid('LE22')` in tests).
- customIds: `right:<listingId>`, `admin-confirm:<listingId>:<cardIds comma-joined>`, `admin-dismiss:<listingId>`; Discord caps a customId at 100 chars.
- Throttle key `confirm-request:<listingId>`, once per 24 h.
- Validate every URL with `validUrl` before a discord.js builder.
- Only `config.botAdminId` may run Confirm/Dismiss.
- Copy (exact): user replies `Thanks — the admin has been notified.`, `Thanks — the admin already has this one.`, `Already confirmed by the admin.`, `The admin could not be reached just now. Please try again later.`, `This listing no longer exists.`; admin refusals `Only the admin can do this.`, `The listing's cards changed since this message; use /admin map.`; admin DM status lines `✅ Confirmed` / `🗑️ Dismissed`.

## Review Focus

- A non-admin presses Confirm or Dismiss (a forwarded DM): nothing changes, ephemeral refusal. Test in Task 3.
- A rescrape changed the listing's cards between DM and click: Confirm refuses, nothing written. Tests in Tasks 1 and 3.
- The admin DM for Right fails: the throttle is released so the next click retries; user told. Test in Task 4.
- The admin presses Confirm twice (two DMs for one listing): second press succeeds idempotently, never re-notifies (`availableSince` unchanged). Test in Task 1.
- A bundle whose ids push the Confirm customId over 100 chars: no Confirm button, Dismiss still present. Test in Task 3.

---

### Task 1: `listingManager.confirmCards`

**Files:**

- Modify: `src/bot/database/listingManager.ts` (next to `overrideCards`, ~line 443)
- Test: `src/bot/database/listingManager.test.ts`

**Interfaces:**

- Produces: `confirmCards(listingId: number, expected: CardId[], now: number): StoredListing | 'changed' | undefined` on `listingManager`. `undefined` = no listing; `'changed'` = the listing's cards (as a set) differ from `expected`, nothing written.

- [ ] **Step 1: Write failing tests** in a `describe('confirmCards')`:
  - `confirms with the current cards and keeps availableSince`: an available `unconfirmed` listing with `availableSince: 1000`, `onHold: true`, similarity 0.7, one open report → result has `matchStatus 'confirmed'`, `manualOverride true`, `similarity null`, `pictureCardId null`, `onHold false`, `availableSince 1000`; the report's `resolvedAt` equals `now`.
  - `refuses when the cards changed`: listing cards `[cid('12')]`, `expected [cid('13')]` → `'changed'`, row unchanged.
  - `returns undefined for a missing listing`.
  - `is idempotent`: second call → same result, `availableSince` still 1000.
  - `survives a rescrape`: after confirm, run the same upsert path the existing `overrideCards` rescrape test uses → still `manualOverride`, `confirmed`.
- [ ] **Step 2:** `./bin/mise run test src/bot/database/listingManager.test.ts -t confirmCards` → FAIL (not a function).
- [ ] **Step 3: Implement** in one `db.transaction`: load row by id, compare its `listingCards` ids as a set with `expected`, then the `overrideCards` update without `writeCards` and without touching `availableSince`, then `resolveReports`; return `load`ed listing. Doc comment states why `availableSince` is kept.
- [ ] **Step 4:** same command → PASS.
- [ ] **Step 5: Commit** `feat(database): confirm a listing's cards without re-notifying`.

### Task 2: Right button on unconfirmed alerts

**Files:**

- Modify: `src/bot/notify/messages.ts` (`buildRow`, ~line 158)
- Test: `src/bot/notify/messages.test.ts`

**Interfaces:**

- Produces: alert rows carry a button with customId `right:<listing.id>`, label `✅ Right #<card>`, style `Success`, placed right after the Wrong button, only when `listing.matchStatus === 'unconfirmed'` and `cardIds.length === 1`.

- [ ] **Step 1: Write failing tests:**
  - `unconfirmed single card gets a Right button after Wrong`: listing `matchStatus 'unconfirmed'` → last two buttons have customIds `report:<id>`, `right:<id>`; Right label `✅ Right #12`.
  - `no Right button` for `confirmed`, `pending`, `no_reference`, and an unconfirmed two-card bundle.
  - `batched rows stay within 5 buttons`: 6 unconfirmed items → every row ≤ 5 components, first label starts with the position marker.
- [ ] **Step 2:** `./bin/mise run test src/bot/notify/messages.test.ts` → new tests FAIL.
- [ ] **Step 3: Implement** in `buildRow`; update its doc comment.
- [ ] **Step 4:** same command → PASS.
- [ ] **Step 5: Commit** `feat(notify): add a Right button to unconfirmed alerts`.

### Task 3: Admin Confirm/Dismiss buttons and handlers

**Files:**

- Create: `src/bot/interactions/adminActions.ts`, `src/bot/interactions/adminActions.test.ts`
- Modify: `src/bot/interactions/report.ts` (`buildAdminReportMessage` uses the shared embed and adds the row), `src/bot/interactions/report.test.ts`

**Interfaces:**

- Consumes: `listingManager.confirmCards` (Task 1), `listingManager.clearHold(url)`, `listingManager.getById(id)`.
- Produces:
  - `adminListingEmbed(listing: StoredListing, title: string): EmbedBuilder` (title, Cards, Shop, URL fields, listing URL, picture, reference thumbnail; moved out of `buildAdminReportMessage`).
  - `adminActionRow(listing: StoredListing, opts: { dismiss: boolean }): ActionRowBuilder<ButtonBuilder> | null` — Confirm (`✅ Confirm #12` / `✅ Confirm bundle`, `Success`) when the customId fits 100 chars and the listing has cards; Dismiss (`🗑️ Dismiss`, `Secondary`) when `opts.dismiss`; null when empty.
  - `handleAdminConfirm(i: ButtonInteraction, deps: { adminId: string }): Promise<void>`
  - `handleAdminDismiss(i: ButtonInteraction, deps: { adminId: string }): Promise<void>`

- [ ] **Step 1: Write failing tests** (`adminActions.test.ts`, fake button like `report.test.ts` plus an `update` spy; message content `'orig'`):
  - `confirm by the admin confirms and updates the DM`: `update` called with `content` ending `\n✅ Confirmed`, `components: []`; listing `confirmed`, `manualOverride`, `availableSince` unchanged.
  - `confirm by someone else changes nothing`: user id ≠ adminId → ephemeral `Only the admin can do this.`, listing unchanged, no `update`.
  - `confirm after the cards changed`: customId names `13`, listing holds `12` → ephemeral `The listing's cards changed since this message; use /admin map.`
  - `confirm/dismiss of a missing listing or malformed id` → ephemeral `This listing no longer exists.`
  - `dismiss lifts the hold and resolves reports`, DM updated with `\n🗑️ Dismissed`, buttons removed; non-admin refused.
  - `adminActionRow`: single card → Confirm + Dismiss customIds `admin-confirm:<id>:12`, `admin-dismiss:<id>`; `{dismiss:false}` → Confirm only; ids making the customId > 100 chars → Dismiss only; no cards and no dismiss → null.
  - In `report.test.ts`: `buildAdminReportMessage` output has one row with Confirm + Dismiss, and still the `/admin map` hint.
  - Handler throws (spy `confirmCards` to throw) → `replyWithError`, no crash.
- [ ] **Step 2:** `./bin/mise run test src/bot/interactions/adminActions.test.ts src/bot/interactions/report.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Parse ids with the same `^\d{1,15}$` rule as `report.ts`; card ids in the customId parsed with the project's card id parser. Status line appended to `i.message.content`, clipped to 2000 chars. Catch-all → `logError('[ADMIN ACTION] …')` + `replyWithError`.
- [ ] **Step 4:** same command → PASS.
- [ ] **Step 5: Commit** `feat(admin): confirm or dismiss a listing with one click`.

### Task 4: User Right handler

**Files:**

- Create: `src/bot/interactions/right.ts`, `src/bot/interactions/right.test.ts`

**Interfaces:**

- Consumes: `adminListingEmbed`, `adminActionRow` (Task 3), `runManager.shouldAlert/lastAlertAt/releaseAlert`.
- Produces: `handleRightButton(i: ButtonInteraction, notifyAdmin: (msg: MessageCreateOptions) => Promise<void>, now?: () => number): Promise<void>`; admin message = `adminListingEmbed(listing, '👍 Card confirmed by a user (listing <id>)')` with a `By` field `<tag> (<id>)` and `adminActionRow(listing, { dismiss: false })`.

- [ ] **Step 1: Write failing tests:**
  - `notifies the admin once`: first click → one `notifyAdmin` call with an admin-confirm button, reply `Thanks — the admin has been notified.` (ephemeral); second click within 24 h → no DM, `Thanks — the admin already has this one.`; after 24 h → DM again.
  - `already confirmed by the admin` (`manualOverride` + `confirmed`) → `Already confirmed by the admin.`, no DM.
  - `missing listing / malformed id` → `This listing no longer exists.`
  - `DM failure releases the throttle`: `notifyAdmin` rejects → reply `The admin could not be reached just now. Please try again later.`; next click DMs again.
  - Listing is not put on hold and no `reports` row is written.
- [ ] **Step 2:** `./bin/mise run test src/bot/interactions/right.test.ts` → FAIL.
- [ ] **Step 3: Implement**; `deferReply` ephemeral before the DM (3 s window, as `handleReportModal`), then `editReply`.
- [ ] **Step 4:** same command → PASS.
- [ ] **Step 5: Commit** `feat(notify): let users confirm a card for the admin`.

### Task 5: Routing, wiring, docs

**Files:**

- Modify: `src/bot/interactions/router.ts`, `src/bot/interactions/router.test.ts`, `src/bot/bot.ts` (button dispatch), `CLAUDE.md` (Decisions to keep), `docs/image-matching.md` (admin confirmation)

**Interfaces:**

- Produces: `ButtonRoute` gains `'right' | 'admin-confirm' | 'admin-dismiss'` with prefixes `right:`, `admin-confirm:`, `admin-dismiss:`.

- [ ] **Step 1: Write failing router tests:** `buttonRoute('right:5') === 'right'`, `buttonRoute('admin-confirm:5:12') === 'admin-confirm'`, `buttonRoute('admin-dismiss:5') === 'admin-dismiss'`; `report:`/`report-reason:` still route as before.
- [ ] **Step 2:** `./bin/mise run test src/bot/interactions/router.test.ts` → FAIL.
- [ ] **Step 3: Implement** the prefixes; wire in `bot.ts`: `right: () => handleRightButton(interaction, dmAdmin)`, `'admin-confirm': () => handleAdminConfirm(interaction, { adminId: config.botAdminId })`, same for dismiss.
- [ ] **Step 4: Docs.** CLAUDE.md decision line: Right button only on single-card `unconfirmed` alerts, one admin DM per listing per day, no hold; admin Confirm = `/admin map` with the current cards but keeps `availableSince` (never re-notifies), refused when cards changed; Dismiss = `/admin clear`; admin only. Same rules in `docs/image-matching.md` where admin mapping is described.
- [ ] **Step 5: Verify all:** `./bin/mise run typecheck`, `./bin/mise run lint`, `./bin/mise run format:check`, `./bin/mise run test` → all pass.
- [ ] **Step 6: Commit** `feat(bot): route Right, Confirm and Dismiss buttons`.

## Amended after review (2026-11-24)

The design above is as approved; review changed these points, and the code follows them:

- **Picture and status checks.** The Confirm customId is
  `admin-confirm:<listing>:<cards>:<picture URL fingerprint>` (built and read only in
  `interactions/buttonIds.ts`).
  `listingManager.confirmCards({ listingId, cardIds, image }, now)` (a `ConfirmTarget`; the
  fingerprint lives in `matcher/imageFingerprint.ts`)
  returns `{ kind: 'confirmed' | 'gone' | 'stale' }`; `stale` names the reason: `cards`,
  `picture` (the picture URL changed since the DM) or `status` (the listing is a `mismatch` or
  `pending`, `isConfirmable` in `matcher/matchStatus.ts`). The admin's reply names the reason.
- **Pictures attached.** The Right and wrong-report admin DMs go through `withPictures`
  (`interactions/adminActions.ts`): pictures attached as in user alerts, resent once without
  them only when Discord refuses the payload (400/413), only logged (no `notify-pictures` alert).
  The thumbnail is the usable reference only, never a placeholder.
- **Right replies.** A listing no longer `unconfirmed` sends nothing ("This listing changed
  since the alert; there is nothing to confirm now."); a malformed button id answers "This button
  is not valid." and is logged. The Right DM carries a content line with the `/admin map`
  command, and the throttle is taken only after the DM is built.
- **Handled DMs.** When the DM cannot be updated after Confirm or Dismiss took effect, the admin
  is told "Confirmed; this message could not be updated." (or "Dismissed; …"), not a failure.
  Both actions are logged.
- **Interfaces.** `handleRightButton(i, { notifyAdmin, now? })`, `handleAdminConfirm(i,
{ adminId, now? })`; one exported `AdminDm` type; `adminListingEmbed(listing, title, lead?)`.
- **Reply texts.** Confirm refusals (`STALE_REPLIES`): "The listing's cards changed since this
  message; look again or use /admin map.", "The listing's picture changed since this message;
  look again or use /admin map.", "The listing's picture check is due again or found another
  card; look again or use /admin map." A throttled Right answers "Thanks — someone already asked
  the admin about this listing today." Replies that cannot be delivered after the action took
  effect are only logged (warn), never reported as a failure of the action.
