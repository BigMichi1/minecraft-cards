# One-click confirm for the admin

Date: 2026-11-24. Status: approved; amended after review (see the end).

## Intent

Today the admin confirms or dismisses a listing by typing `/admin map url:… cards:…` or
`/admin clear url:…`. The goal is a one-click alternative: users flag a listing as right from
the alert, and the admin confirms (or dismisses) with a button instead of a command.

## Goals

- Alert DMs with "⚠️ number unconfirmed" get a **✅ Right #LE22** button next to
  **❌ Wrong #LE22**. Clicking it DMs the admin the listing with a **✅ Confirm #LE22** button.
- Admin's Confirm does what `/admin map` does with the listing's current cards: `confirmed`,
  `manualOverride`, survives rescrapes, later alerts show "✅ checked by the admin".
- The existing "⚠️ Wrong card reported" admin DM gets two buttons: **✅ Confirm #…**
  (as above, lifts the hold, resolves the reports) and **🗑️ Dismiss** (same as `/admin clear`).

## Non-goals

- Editing alert DMs already sent to users.
- Mapping to _other_ cards by button: a wrong number still needs `/admin map … cards:…`.
- Retrying a failed "right" DM to the admin, or storing who clicked Right.

## Anti-goals

- Confirming must not re-notify users who already got the alert for this listing
  (invariant: staying in stock never re-notifies).
- Anyone but the admin pressing Confirm/Dismiss changes nothing.
- Many users clicking Right must not flood the admin.

## Approaches

- **A. No new table (picked).** Right → immediate admin DM, throttled per listing per day via
  `runManager.shouldAlert`; Confirm reuses the mapping logic. Lost if the DM fails; low stakes.
- **B. Reuse `reports`.** Durable and retried, but needs a migration and teaching every
  "report = pause listing" path that this kind does not pause. Too much for a typing shortcut.
- **Extra (picked with A):** Confirm/Dismiss buttons on the existing wrong-report admin DM.

## Design

- **Right button** (`notify/messages.ts` `buildRow`): only on single-card listings with
  `matchStatus === 'unconfirmed'`. customId `right:<listingId>`. Row stays within 5 buttons.
- **Right handler** (`interactions/`, new module or next to `report.ts`): listing gone →
  "This listing no longer exists."; already admin-confirmed → "Already confirmed by the admin.";
  throttled (`confirm-request:<listingId>`, once per day) → "Thanks — the admin already has
  this one."; else DM the admin (embed like the report DM: picture, reference thumbnail, cards,
  shop, URL, who clicked) with Confirm, reply "Thanks — the admin has been notified." or, if the
  DM failed, "The admin could not be reached just now." No hold, no report row.
- **Confirm button** customId `admin-confirm:<listingId>:<cardIds comma-joined>`. Handler:
  only `config.botAdminId`; listing gone, or its cards no longer equal the ids in the button →
  refuse with a short ephemeral note (the admin uses `/admin map`). Otherwise a new
  `listingManager.confirmCards(listingId, cardIds, now)`: like `overrideCards` (manualOverride,
  `confirmed`, similarity and pictureCardId null, hold lifted, reports resolved) but **keeps
  `availableSince`**, so nobody is re-notified. The admin's DM is updated: buttons removed,
  "✅ Confirmed" added. If the ids would make the customId exceed 100 characters, no Confirm
  button (the command still works).
- **Dismiss button** customId `admin-dismiss:<listingId>`: admin only; `clearHold` by the
  listing's URL; DM updated to "🗑️ Dismissed", buttons removed.
- **Router** (`interactions/router.ts`): routes `right:`, `admin-confirm:`, `admin-dismiss:`;
  `bot.ts` wires them with `notifyAdmin` and `adminId`.
- **Docs**: CLAUDE.md "Decisions to keep" line, `docs/image-matching.md` (admin confirmation
  paths). Tests for every new module and each anti-goal.

## Left to the builder

Module split and naming, the exact embed layout (reuse `buildAdminReportMessage` parts), and
whether the Wrong-report DM keeps its command hint text alongside the buttons (default: keep it,
it is the path for other cards).

## Amended after review (2026-11-24)

The design above is as approved; review changed these points, and the code follows them:

- **Picture and status checks.** The Confirm customId is
  `admin-confirm:<listing>:<cards>:<picture URL fingerprint>` (built and read only in
  `interactions/buttonIds.ts`). `listingManager.confirmCards(listingId, { cardIds, image }, now)`
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
