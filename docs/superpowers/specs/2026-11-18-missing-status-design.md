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
- Shop block: one line per shop (sammel-ente, blue-ocean, eBay), taken from the last run summary:
  - `✅ <shop>  <n> listings`
  - `❌ <shop>  error at <time> – <reason>`
  - `⚠️ <shop>  not checked`: the shop is absent from the last run, e.g. eBay without credentials.
- Card block: one line per missing card, in `compareCardIds` order, with the catalog name when
  known. Per shop that has a stored listing of the card:
  - `<price> in stock`
  - `sold out`
  - `paused (reported)`: the listing is available but on hold.
  - Bundles count as listings of each card they contain; the entry is marked "(bundle)".
  - No listing at any shop: "not listed in any shop".
  - For a shop whose last check failed, its entries carry "(as of <last successful check>)".
- Length: Discord's 2000-character limit applies. Cards that don't fit end with
  "… and N more cards" (the `joinWithinLimit` style used elsewhere).
- An empty list replies "You have no missing cards on your list." (same text as `/missing list`).
- No run yet: the shop block says "No check has run yet." and the cards show "not checked yet".

## Non-goals

- No new stored data, schema change or extra shop requests. This is read-only.
- No change to `/missing list`, notifications or `/admin status`.

## Approach

Only one approach is sensible: read the existing data.

- **Run summaries:** `runManager.last()` gives the latest summary. A new
  `runManager.lastSuccess(shop)` gives the newest run in which that shop had no error, for
  "(as of …)".
- **Listings:** a new `listingManager.listingsForCards(cardIds)` returns the stored listings that
  carry any of the given cards: shop, available, onHold, price, format and cardIds.

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

## Left to the builder

- Exact formatting helpers and line layout within the 2000-character limit.
- Whether to show more than one listing per shop for a card. Pick the best one: in stock beats
  sold out, then the lowest price.
