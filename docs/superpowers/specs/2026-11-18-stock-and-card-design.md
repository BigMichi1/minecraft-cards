# `/stock` and `/card`: design

Date: 2026-11-18. Status: approved in conversation (option A for `/stock`; `/card` as sketched).

## Intent

`/missing status` shows only one user's missing cards. The user also wants two more things: an
overview of the whole catalog, showing where each card can be bought right now, and a quick way
to open the shop page for one card.

## `/stock`

- Shows every catalog card (251: 1–228, LE1–LE22, XXL1), sorted like `compareCardIds`.
- Rows show the card number only, with no name, to keep the table narrow. Columns are the shops,
  in `SHOP_IDS` order.
- Cell values:
  - `x` in stock;
  - `-` not available;
  - `?` when the shop's last check failed or did not run and nothing is stored;
  - `n/a` when the shop is not enabled.
  - No prices.
  - A listing that is held back (mismatch) or paused counts as not available.
  - Inside the code block use ASCII only, so the columns line up. The same lesson came from the
    `/missing status` table (PR #17). Use `x` and `-`, not ✅.
- Filter option `only`:
  - `all` (default);
  - `missing`: the user's missing list;
  - `in-stock`: cards available in at least one shop.
  - An empty result gives a short sentence instead of a table.
- Paging:
  - one code block per page, about 60–80 rows, sized to fit the 2000-character limit;
  - "page x/y" in the header;
  - ◀ ▶ buttons in the same ephemeral reply.
  - The custom id carries the page and the filter. A click re-renders from current data with
    `interaction.update`. Only the user who ran the command can page; Discord shows ephemeral
    replies to that user only anyway.
  - Buttons at the ends are disabled.
- Header line: the same last-check time and shop status summary as `/missing status`, kept short.
- Ephemeral.

## `/card number:<id> [shop:<shop>]`

- `number` is a canonical card id (`normalizeCardId`). An unknown or invalid id answers
  "unknown card" and names the token.
- The reply is an ephemeral embed.
  - Title: `#12 Squid` (catalog name).
  - One line per shop with the best listing per shop, using the same choice as
    `/missing status`:
    - status (in stock with price, sold out, held back, paused, not listed, `?` or n/a);
    - `(N offers)` when a shop has several available listings, eBay in particular.
  - The reference picture as thumbnail, attached like the alerts, falling back to the URL.
- Link buttons `[Open <shop>]`:
  - one per shop that has an available listing, pointing to its cheapest available listing;
  - every URL passes `validUrl`;
  - at most 5 per row;
  - a Kleinanzeigen search button as in the alerts.
- `shop:` limits the reply to that shop (with its link button).
- The `shop` option offers choices from `SHOP_IDS`; a shop that is not enabled answers "not
  enabled".

## Shared

- Put the cell and best-listing logic shared with `/missing status` in one module. Do not copy
  it.
- `/help` lists both commands.
- Commands are registered statically in `bot.ts`, per CLAUDE.md.
- Tests next to every new file. Builders stay pure, with the Discord wiring kept thin.

## Decided by the user

- `/stock` option A: pages with ◀ ▶, and an `only` filter.
- `/card` shows every shop with an Open button, and `shop:` limits it to one shop.
- Build both in one PR, after picture identification.

## Calls made by Claude

- The names `/stock` and `/card`.
- `/stock` cells show no price; prices and links are in `/card` and `/missing status`.
- ASCII markers in the `/stock` code block, as learned in PR #17.
- Held-back and paused listings count as not available in `/stock`.

## Outcome

- `/stock` columns are headed `SE`, `BO`, `CI`, `EB`, spelled out in a legend line under the
  block, so a row is 24 characters. Every row is padded to that full width, and a page takes as
  many rows as fit in 2000 characters (one more would not): about 68 with a normal header.
- Offers of one shop for one card are the in-stock listings, seen as recently as the shown
  (best) listing. They are ordered: single cards backed by their picture (confirmed or reference)
  first, then other single cards (pending, unconfirmed and the like), then bundles, each group
  cheapest first. `/card` uses the first offer with a valid URL for `Open <shop>` and for
  `, from <price>`. A bundle or an unconfirmed picture is linked or named as "from" only when no
  backed single is on offer.
- Prices compare only in one currency: EUR when any listing of the shop and card has a EUR
  price, else the first priced listing's currency. A price in another currency counts like a
  missing price. "From" appears only when the first offer is in the shown listing's currency and
  cheaper, or the shown listing has no price.
- With `shop:` the Kleinanzeigen button is left out.
