# `/missing status`: design

Date: 2026-11-18. Status: approved in conversation.

## Intent

A user wants to see, in one reply, their missing cards and for each one what the shops showed at
the last check, plus when each shop was last checked and whether that check worked. Today
`/missing list` only lists the numbers. Success means seeing "is any of my cards available
somewhere, and how fresh is that information" without waiting for a DM.

## Goals

- New subcommand `/missing status`. The reply is ephemeral, like every other `/missing` reply.
- Header: the card count, plus the time of the last check as a Discord relative timestamp.
- Header warnings: "⚠️ The last check is older than 7 days; stock may have changed." when the
  last check started more than `LAST_SUCCESS_WINDOW_MS` (7 days) ago; "⚠️ The latest check record could not be read; showing the one before." when
  the newest run record is unreadable; "❌ Last check failed: <reason>" when the run failed outside
  a single shop.
- Shop block: one line per shop (sammel-ente, blue-ocean, eBay), taken from the last run summary:
  - `✅ <shop>: <n> listings`
  - `❌ <shop>: error <t:…:R> – <reason>`
  - `⚠️ <shop>: not checked`: the shop is enabled but absent from the last run.
  - `⚪ <shop>: not enabled`: the bot builds no adapter for it (eBay without credentials); its
    stored listings are not shown.
- Card block: one line per missing card, in `compareCardIds` order, with the catalog name when
  known. Per enabled shop that has a stored listing of the card, its best listing:
  - `<price> in stock` (no price when the shop gives none)
  - `sold out`
  - `auction ended`: an auction whose end has passed, even if the last check saw it running.
  - `paused (reported)`: the listing is available but on hold.
  - Bundles count as listings of each card they contain; the entry is marked "(bundle)". A
    single-card listing whose picture is not `reference` or `confirmed` is marked
    "(picture unconfirmed)". A listing the shop's latest successful check did not return is marked
    "(not seen in last check)".
  - Best order: seen in the latest check, then in stock, paused, sold out or ended; then a backed
    picture; then the lowest price. Bundles are never compared, so they never count as
    picture-backed.
  - For a shop whose last check failed or that was absent from it, its entries carry
    "(as of <t:…:R>)" with the earlier of the shop's last success and when a check last returned
    the listing, or "(no successful check in 7 days)" (the days come from
    `LAST_SUCCESS_WINDOW_MS`). A card it
    has no listing of reads "<shop> unknown (check failed)" or "<shop> unknown (not checked)".
  - "not listed in any shop" only when every enabled shop's latest check succeeded and none lists
    the card.
- Length: Discord's 2000-character limit applies. Cards that don't fit end with
  "… and N more cards" (the `joinWithinLimit` style used elsewhere).
- An empty list replies "You have no missing cards on your list." (same text as `/missing list`).
- No run yet: the line after the header says "No check has run yet." and the cards show
  "not checked yet".
  Only unreadable run records: "⚠️ No readable check record." and every card "unknown".
- A failure replies "Could not load your stock status. Please try again later."

## Non-goals

- No new stored data, schema change or extra shop requests. This is read-only.
- No change to `/missing list`, notifications or `/admin status`.

## Approach

Only one approach is sensible: read the existing data.

- **Run summaries:** `runManager.latestReadable()` gives the newest readable summary and whether
  a newer row was unreadable. `runManager.lastSuccess(shop, now)` gives the newest run within
  7 days in which that shop had no error, for "(as of …)".
- **Listings:** a new `listingManager.listingsForCards(cardIds)` returns the stored listings that
  carry any of the given cards: shop, available, onHold, price, format, cardIds, matchStatus and
  lastSeenAt (already stored).
- **Enabled shops:** `bot.ts` passes the ids of the adapters it built to `/missing`.

Alternatives rejected:

- **Storing per-card check results:** that would mean new tables to hold data we already have.
- **A live shop request on demand:** slow (minutes), and against the polite-crawling constraint.

## Decided by the user

- Show the missing cards with their per-shop state, plus each shop's last check time and result,
  in the sketched layout.

## Calls made by Claude

- Shops absent from the last run show as "not checked".
- Entries for a failed shop are marked "(as of …)".
- Held listings show as "paused (reported)".
- Bundles are listed per card, marked "(bundle)".
- The reply is ephemeral.
- Overflow is shown as "… and N more cards".

Added after the pr-review-toolkit review of PR #13, so the reply never states stock it cannot
back:

- A failed or unchecked shop is "unknown" for cards it has no listing of.
- Shops without an adapter show as "not enabled" and contribute no entries.
- "(as of …)" applies to absent shops too and only looks back 7 days.
- Ended auctions, unconfirmed pictures and listings the last check did not return are marked, and
  rank below the others.
- Unreadable run records and a failed run are announced in the header.
- `/missing status` has its own error text; the log names the subcommand.

## Left to the builder

- Exact formatting helpers and line layout within the 2000-character limit.
- Whether to show more than one listing per shop for a card. Pick the best one (see "Best order"
  under Goals).
