# collect-it.de shop and `/missing status` table: design

Date: 2026-11-18. Status: approved in conversation. It ships as two PRs: the shop first, then the table.

## Intent

More places that sell single "On Fire" cards mean more chances to complete the collection.
collect-it.de is the only further German shop found that sells single series 3 cards (research in
`docs/shops.md`). The `/missing status` reply is read mostly on a PC. As a table (cards down, shops
across) it shows at a glance where a card can be bought.

## Part 1: collect-it.de adapter

- New `ShopId` `collect-it`, display name `collect-it`, plus its adapter `src/bot/shops/collectIt.ts`,
  built the same way as the sammel-ente and blue-ocean adapters.
- Source: `https://www.collect-it.de/sammelkarten/lego/minecraft/serie-3/Einzelkarten`, page N at
  `…/Einzelkarten_sN`, 30 cards per page. On 2026-11-18 it had 235 singles over 8 pages.
- Card id: the number at the start of the product title, as in `12 - Squid - Charakterkarte - Serie 3`
  (the base card #12). How LE and XXL cards are titled is still unknown. The builder checks the
  fixtures: map them if they are present; otherwise skip a title whose id cannot be read and count
  it as skipped, as the other adapters do.
  - Outcome (2026-11-18): LE cards are titled `LE01 - …` (→ `LE1`); there is no XXL card in the
    category. Because collect-it hides sold-out cards, a title whose id cannot be read is a
    `ShopLayoutError`, not a skipped count.
- Card name: the text after the number, cut before the first " - ".
- Stock: from the listing page if it shows availability per product. Otherwise use the product page's
  schema.org `availability` (`InStock` / `OutOfStock`), but only when the listing page lacks it, and
  only for cards that someone wants, so a run does not request 235 product pages. The builder decides
  from the fixtures, preferring the listing page.
  - Outcome (2026-11-18): stock is read from the listing page's schema.org `availability`; no
    product pages are requested. Sold-out cards are hidden from the category, so a card that sells
    out vanishes.
- Price: euro cents from the page (`0,55 €` → 55).
- Picture: the product image URL. The image host is added to the matcher's allow-list.
- Matching: collect-it is not a reference shop. Its single-card listings start `pending` and are
  compared against the sammel-ente reference picture, like blue-ocean.
- Errors: the same rules as the other shops. A run that parses zero cards, a page that is not a
  category page, or an empty later page raises `ShopLayoutError`.
- Requests: same User-Agent, 20 s timeout, 1500 ms between pages.
- `docs/shops.md` records the research and is added in this PR.

## Part 2: `/missing status` as a table

- Card lines become one fixed-width block, written as a Markdown code block with ` ``` `.
  - Rows are cards, `#<id> <name>`, with the name shortened to keep the column width.
  - Columns are the shops in `SHOP_IDS` order. Shops that are not enabled are still shown, and
    every cell in their column reads `n/a`.
- Cell values (per shop, same best-listing choice as today):
  - a price such as `0,55 €`, or `in stock` without a price;
  - `sold out`, `ended` for an auction that is over, `paused` for a listing held after a report;
  - `–` when the shop lists no such card and its last check succeeded;
  - `?` when the shop's last check failed or did not run and nothing is stored;
  - `n/a` when the shop is not enabled.
- Markers appended to a cell:
  - `⏱` for data older than the last check, covering both "as of" and "not seen in last check";
  - `⚠` for a picture that is not confirmed;
  - `+` for a bundle.
- A legend line under the block explains the markers that appear. The exact times ("as of …") move
  to the shop lines above the table, so the cells stay narrow.
- The header and shop lines stay as they are now, above the table.
- Overflow: whole table rows are kept while the reply fits in 2000 characters, followed by
  "… and N more cards" outside the block.
- The design is for PC width. Mobile wraps; that is accepted.

### Outcome

Built as designed, plus links ("option A", approved by the user while building), with one
change from review: the code block holds only ASCII (plus `€`, `–` and `…`). Discord draws `⏱`
and `⚠` about two columns wide and most superscript digits in a proportional font, which broke
the column alignment.

- Markers in the cells are `*` (older than the last check, ⏱), `!` (picture unconfirmed, ⚠) and
  `+` (bundle). `⏱` and `⚠` appear only in the legend and on the shop lines.
- Every in-stock cell whose listing URL passes `validUrl` gets a reference `[1]`, `[2]`, …,
  numbered row by row and left to right. A cell with an invalid URL gets no reference, and the
  next linked cell takes the number.
- An embed under the message lists each reference as a markdown link,
  `[1] [#140 Wither · blue-ocean · 0,80 €](url)` (`(bundle)` added for a bundle). Brackets and
  backslashes in the text are escaped, and parentheses and whitespace in the URL
  percent-encoded. Only rows kept in the message are linked; links over 4096 characters end in
  "… and N more links". No in-stock cell means no embed.
- Cells read the value, then after one space the markers and the reference: `0,55 € [1]`,
  `0,55 € *![3]`, `sold out +`.
- The legend reads ``Legend: `*` ⏱ older than the last check · `!` ⚠ picture unconfirmed · `+`
bundle`` (the ASCII markers in inline code, so `*` is not italics). It names only the markers
  in the rows shown and comes after "… and N more cards" when rows were cut.
- A shop whose check failed or did not run gets ` · data as of <t:…:R>` (its last success) or
  ` · no successful check in 7 days` on its shop line; its stored cells get `*`.
- Per shop the best listing is chosen as before: what the latest check returned first, then in
  stock before paused before sold out or ended. A sold-out listing the check saw beats an
  in-stock one it did not return.
- Without a readable check run, every enabled cell is `?`.
- Widths: each shop column is as wide as its widest cell or shop name, with two spaces between
  columns. The card column gets what is left of 84 characters, at least 14. Longer
  `#id name` labels end in `…` and the id is never cut; link texts keep up to 60 characters of the
  label. Backticks in names become `'`, so a name cannot close the code block.

## Decided by the user

- Add collect-it.de as a shop.
- A table with cards down and shops across, for PC.
- Keep a written list of the checked shops and whether they sell singles and are readable
  (`docs/shops.md`).

## Calls made by Claude

- Two PRs, the shop first, so the table has its column from the start.
- Cell markers are short symbols with a legend; exact times stay on the shop lines.
- `n/a` is shown for shops that are not enabled, so their column stays put and they don't vanish.

## Left to the builder

- The exact HTML selectors and paging stop for collect-it, decided from saved fixtures.
- Column widths and how names are shortened.
