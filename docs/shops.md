# Shops

Which shops were checked for LEGO Minecraft TCC series 3 ("On Fire") single cards, whether they sell
them, and whether the bot can read them. Checked 2026-11-17 / 2026-11-18. Re-check when a shop
changes or a new one is suggested.

## Used by the bot

| Shop                                                                                                  | Sells singles                   | Readable                         | How the bot reads it                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [shop-sammel-ente.de](https://shop-sammel-ente.de/Minecraft/Serie-3/)                                 | yes (all 228 + LE + XXL1)       | yes                              | Shopware storefront HTML, `?p=N` pages. Card id from the title (`#012 Squid`). Its pictures are the image reference for every other shop.                                                                                                                                |
| [blue-ocean.de](https://www.blue-ocean.de/produkte/lego/lego-minecraft/lego-minecraft-sticker-cards/) | yes (the publisher's own shop)  | yes                              | Shopware + Nuxt HTML, `?p=N` pages. Card id from the product URL suffix (`…-tcc-on-fire-2dd00088-12`); the title's "Nr." is wrong. Only "On Fire" titles count; series 1 and 2 share the category.                                                                       |
| [collect-it.de](https://www.collect-it.de/sammelkarten/lego/minecraft/serie-3/Einzelkarten)           | yes (235 singles)               | yes                              | JTL shop HTML, 30 per page (`…/Einzelkarten_sN`), walked by `<link rel="next">`. Card id at the start of the title (`12 - Squid - …`, `LE01 - …`); price and stock from the listing page.                                                                                |
| eBay (`EBAY_DE`)                                                                                      | yes (private and trade sellers) | yes, via the official Browse API | Developer account approved and the marketplace account deletion exemption granted ("I do not persist eBay data"); enabled by setting `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`. Four searches, every page by `offset`. Card ids from series 3 titles only (details below). |

## eBay details

Checked against a live probe of 2026-11-18 (234 unique items over six queries; 38 of them, without
seller data, are in `src/test/fixtures/ebay-search.json`):

- **Queries** (`EBAY_QUERIES`): `lego minecraft on fire karte`, `lego minecraft tcc serie 3`,
  `lego minecraft trading card on fire` and `lego minecraft karten serie 3`. The last one finds the
  single cards (295 results on 2026-11-18; the other three found 2 to 30 each, almost all of them
  packs, limited cards and pick lists). `tcc serie 3` found nothing usable that day but is kept: it
  costs one request and catches titles without "Karten" or "On Fire".
- **Paging**: each search is read page by page, 200 items per page, with `offset` = page number
  × 200. eBay takes only offsets that are zero or a multiple of `limit` (any other is an HTTP 400),
  and a page may hold fewer than 200 items before the end (199 on 2026-11-19), so the offset is
  not the number of items read, and a short page never ends a walk by itself. The walk ends at an
  empty page, or once the next offset reaches the answer's `total` (a later page without a
  `total` keeps the earlier one); the items read are then checked against the `total`
  (tolerance below). At most 5 pages (offsets below 1000) per query. 1500 ms between two search
  requests, as between two shop pages.
- **Errors**: a failing page is a shop error, like a failing shop page. So is a partial walk,
  because the unread listings would be marked unavailable: a walk that ends (on the last page by
  the `total`, or on an empty later page) further below the `total` than its tolerance, a walk at
  the cap that read more than 20 items fewer than 1000, an empty first page with a `total` above
  0, a first page with neither `itemSummaries` nor `total` (`{"total":0}` is a valid empty result),
  and an answer of the wrong shape (not an object, `itemSummaries` not a list of items,
  `total` not a number) are `ShopLayoutError`s naming the query and the offset. All searches
  together returning no item is a `ShopLayoutError` as before.
- **Total tolerance**: eBay's `total` is an estimate and its pages may be short, so a walk may end
  up to max(5, ceil(2 % of the total)) items short of it (455 announced, 450 delivered; 448 of 450
  in pages of 199); an empty first page with a `total` above 0 is always an error. That gap is
  accepted with a warning naming the query, the total and the count read, and no admin alert; a
  larger gap (600 announced, 400 delivered) stays a `ShopLayoutError`. The page cap is reached only
  with a `total` above 1000, or none: there, the offsets read hold 1000 items whatever the estimate,
  so more than tolerance(1000) = 20 fewer is a `ShopLayoutError` (1500 announced, 500 read; 1001
  announced, 979 read), a `total` within the tolerance of the items read counts as complete (1021
  announced, 1000 read), and a larger one is a cut search (below; 1022 announced, 1000 read).
- **Page cap**: a search cut at the cap logs a warning and is reported in `FetchResult.truncated`;
  the runner sends a throttled admin alert (`shop-truncated:ebay`, at most once a day), and
  `/admin status` shows the number of cut searches.
- **Title forms read** (allow-lists, since a false id sends a false DM):
  - `LEGO Minecraft Karten 30 - Steve - Charakterkarte Serie 3 (2026)` and
    `LEGO Minecraft  132 - Wither Skeleton - Charakterkarte - Holo Serie 3 (2026)`: a number, a
    spaced dash, a name, a spaced dash and a known card type (`Charakterkarte`, `Comickarte`,
    `Puzzlekarte`, `Setkarte`, the four of the probe; `Sammelkarte` or `Einzelkarte` is not a
    type). A hyphen inside the name (`Die End-Arena`) is fine. The name must not start with a
    pack or product word (`Booster`, `Pack`, `Lot`, `Set`, `Holo`, `Display`, `Konvolut`,
    `Paket`, `Album`, `Stück`, …), and a number right after `Serie`, `Series` or `Staffel` is
    never read (`Serie 3 - Steve - Charakterkarte` gives no id). `Karten N - Name` without a
    card type is not read: every such title in the probe had one.
  - `… ULTRA RARE ZOMBIE 68 Karte`: a number directly before the singular `Karte` / `Card`, only
    right after a card name word (`CARD_NAME_WORDS`: the characters and mobs of the probe's
    series 3 card names, such as `Zombie`, `Villager`, `Horseman`). `Booster 5 Karte`,
    `Holo 3 Karte` or `neu 2 Karte` give no id.
  - the earlier forms: `#12`, `Nr. 12`, `Nr41`, `Karte 12`, `LE8`, `LE 08`, `XXL1`, `12/228` and
    lists such as `#12, #45 und 107`.

  Counts are not ids: `6 Karten`, `21 Packs à 6 Karten`, `193 verschiedene Karten`,
  `incl. 1 special Card`, and the series number in `Serie 3 Karte`. Counts, units, prices and
  slogans are never ids. One shared list, `COUNT_WORDS` in `src/bot/shops/ebay.ts`, holds them all:
  - products and their plurals: Album, Alben, Blister(s), Booster(s), Box, Boxen, Bundle(s),
    Cards, Display(s), Foil, Holo, Karten, Konvolut, Lot(s), Mappe(n), Multipack(s), Pack,
    Packs, Packung(en), Paket(e), Sammlung, Set(s), Starter;
  - counts and units: Exemplare, fach, mal, pcs, St., Stk, Stück, Stueck, Teile, weitere, x;
  - prices and extras: dazu, EUR, Euro, gratis;
  - seller slogans: Bestseller, Fan, Händler, Seller, Verkäufer;
  - and the signs `€` and `-fach`.

  Every number form checks it. A number after a prefix (the first one too), an LE/XXL number and
  `NAME N Karte` (after the card word) are refused when a decimal (`1,50`) or a word of the list
  follows. The dash form refuses a name starting with one. So `Karte 5 Stück`, `Karte 2 €`,
  `Karte 2-fach`, `#1 Bestseller`, `LE 3 Karten`, `XXL 1 Stück`, `Wolf 3 Card Pack`,
  `Zombie 2 Karte gratis` and `5 - Stueck - Charakterkarte` give no id. A word added to the list
  guards every form; add it to the equality test in `ebay.test.ts` too. The list includes
  Sammelkarte and Sammelkarten (`Karte 2 Sammelkarten` gives no id). Only `#1`, `Nr. 1` or
  `No. 1` followed by `in` is a slogan (`Nr. 1 in Deutschland`); any other number before `in`
  stays a card (`Karte 12 in OVP`, `#45 in Schutzhülle`). The dash form also refuses names
  starting with Neu, Neuware, Rare, Gold, Goldkarte, Doppel, Doppelt or Karte, and a number
  after `je`, `2x`, `2 x` or a unit word (`Stück 5 - …`).

- **Extending `CARD_NAME_WORDS`**: when a real `NAME N Karte` title is missed because its name
  word is not in the list, take the word from that card's name in the catalog (laststicker's
  name, as `/missing status` shows it), never a pack, count or variant word. Add it to
  `CARD_NAME_WORDS` in `src/bot/shops/ebay.ts` and to the equality test in `ebay.test.ts`, and
  add the real title to `src/test/fixtures/ebay-search.json` (without seller data) with its
  reviewed ids in `FIXTURE_IDS`.

- **Series 3 only**: ids come only from a title that names series 3 (`Serie 3`, `Series 3`,
  `Serie3`, `On Fire`) and no other series. A title naming series 1 or 2 gives no ids even when it
  also names series 3: a mixed lot is ambiguous. A title with no series word gives no ids either,
  even in the clear `Karten N - Name - Charakterkarte` form: series 1 and 2 used the same forms
  (`Serie 1 Trading Card 3 - Comic Steve - Skin Karte`, numbers up to 254), and every series 3
  single in the probe named its series.
- **No series word, but the catalog name** (`nameMatchedCardIds`): a title without any series
  word still gives a card when the name of that number in the eBay adapter's collection (the
  catalog name, synced from laststicker, read at the start of each eBay fetch) stands right
  beside it: `LEGO Minecraft Karte 131 - Ghast` is #131,
  because series 3 #131 is "Ghast".
  - The number comes from the title forms above, a plain `N - Name`, or `LE`/`XXL` with any
    spacing (`LE 19 - Creeper` is LE19). The name follows it (spaces and at most one `-`, `–`,
    `—`, `:` or `|` between) or stands before it (`Wither Skeleton Karte 4`, `Karte #4`). Case,
    umlaut spelling (`ä`/`ae`) and punctuation between its words (`Sunny vs Blaze`,
    `Ender-Knight`) do not matter; glued words (`EnderKnight`) do.
  - Every number read must carry its own name. Then the cards' numbers and names are taken out,
    and only punctuation and the allowed words (`NAME_TITLE_WORDS`: `LEGO`, `Minecraft`,
    `Karte`, `Card`, `Trading`, `TCC`, `TCG`, `Einzelkarte`, `Ultra`, `Rare`, `Common`, `Neu`,
    `OVP`, `Nr`, `No`, `2026`, `Charakterkarte`) may be left; `Comickarte 3 - Steve` gives
    nothing. Puzzle cards carry laststicker's English names ("The Overworld 1"), so a German
    `Puzzlekarte Oberwelt 1` title no longer matches by name; they are never identified by
    picture alone anyway. The catalog names come from laststicker; on 2026-11-24 they equalled
    sammel-ente's apart from the 36 puzzle cards, and all 43 titles of the eBay fixture read the
    same with them. Any other word gives nothing: another
    series (`Comic Karte 3 - Steve`, series 1 card 3 is "Comic Steve"; `Staffel 2`, `S1`),
    another card's longer name (`Gold Ghast Karte 131`, `Karte 131 - Ghast (Gold)`: LE21 is
    "Gold Ghast"), a second card without its number (`Karte 3 - Steve / Alex`), another product
    (`Sticker`, `Movie`), or another number (`2025`). Several cards each beside their own name
    give all of them, in any order.
  - Titles with a pick list, range, variation or `COUNT_WORDS` word never qualify, so the common
    `Karten N - Name - Charakterkarte` form and `Holo`, `Foil` or `Sammelkarte` titles are not
    read by name.
  - A name several series 3 cards share counts beside each of their numbers: Ghast is #15, #102,
    #104 and #131 (laststicker and sammel-ente, 2026-11-24), so `LEGO Minecraft Karte 104 - Ghast`
    (2026-11-19) is read as #104. A series 1 or 2 card with the same number and name, and nothing else in its title,
    passes too; it starts `pending` and its picture is compared as for any title, so a clearly
    other series 3 card becomes a `mismatch`, and an unclear picture an alert marked "number
    unconfirmed" (`docs/image-matching.md`). Multi-collection step 3, with the series 1 and 2
    catalogs loaded, is to place such a title by name only when no other series has that name at
    that number (`docs/superpowers/specs/2026-11-19-multi-collection-design.md`).
- **No stock from pick lists**: no ids from listings the buyer picks a card from (`aussuchen`,
  `auswählen`, `Auswahl`, `wählen`, `waehlen`, `du wählst`, `choose`, `pick` as a whole word, so
  `Pickaxe` is not one), from titles with a number range (`Einzelkarten 1 - 228`, `151-254`,
  `LE1 - LE22`, `1 bis 228`), or from listings with seller-defined variations (`itemGroupType`):
  a range or a choice says nothing about which card is in stock. A range has at most three digits
  on each side and a first number below the second, so `Serie 3 - 2026` and
  `107/228 - 1 Stück` are not ranges.
- **Counters**: titles excluded by the series, pick-list, range or variation rules (and not
  read by their catalog name) are counted as `skippedExcluded` ("not series 3 single cards" in
  `/admin status`), series 3 titles naming no card as `skippedNoId` ("without card number");
  both are logged with their reason at debug level. A series 3 title naming no card but with no
  count word and no number besides the series and a year (`isPictureCandidate`) is not skipped:
  it is passed on without ids for the picture to decide (`docs/image-matching.md`, rule 4).
  Items without a link or title (`skippedInvalid`) are counted once per item, not once per
  search that returns them.
- **Result**: on 2026-11-18 the adapter found 4 listings with ids before this change and 244
  after the second review round (226 distinct card ids, no bundles); 31 items were excluded
  (series 1 and 2, no series word, pick lists, ranges, variations) and 53 skipped without a card
  id (packs, displays, boosters).
- **Fixture**: seller fields (`seller.username`, `feedbackScore`, `feedbackPercentage`, account
  type), `itemLocation` and the other fields the adapter does not read are dropped; item ids,
  titles, prices, shipping costs, image URLs, buying options and the variation group are kept.

## collect-it.de details

Read from the saved pages of 2026-11-18 (`src/test/fixtures/collect-it-*.html`, fetched with the bot's
User-Agent):

- **Pages**: `…/Einzelkarten` is page 1, `…/Einzelkarten_sN` page N, 30 products per page; 235
  singles on 8 pages (25 on page 8). Each page but the last has `<link rel="next">`, and each
  page's canonical link names its own page. A page past the end (`_s9`, `_s99`) answers
  `301` to page 1, so there is no empty page that ends the list: the adapter follows the
  `rel="next"` href and stops at the page without one. Because sold-out cards are hidden
  (below), a partial read would mark real listings sold out. So a page whose canonical link is
  missing, unreadable, or names another page than the one linked (the shop shrank during a
  run) is a shop error (`ShopLayoutError`), as is reaching the 60-page cap or any unreadable
  product box or title. The run is retried next hour, and stored listings are left untouched.
  A canonical or next link is readable only as exactly the category URL (page 1) or the
  category URL plus `_sN`, with no trailing slash, query or fragment, and a next link must name
  the following page.
- **Total and full pages**: each page has a pagination text, `Du hast 30 von 235 Artikeln
gesehen` on a page with a next page and `Du hast alle 235 Artikel gesehen` on the last. Page 1
  must have it; a later page may lack it, but one it has must be readable and name the same
  total. At the end, the number of unique listings read must equal the total. Every page that
  links a next page must hold exactly 30 products. Either check failing is a `ShopLayoutError`.
  They catch a dropped `rel="next"` (page 1 alone would otherwise read as the whole shop) and a
  card selling out during the walk, which moves a later card onto a page already read.
- **Error texts**: shop-controlled values quoted in errors and warnings (links, titles,
  availability, the pagination text) are clipped to 200 characters, and every admin alert is
  clipped to Discord's 2000-character limit, so an alert is never rejected.
- **Products**: `#product-list .c-product-box`, schema.org `Product` microdata. Title in
  `.c-product-box-content-title`; the product link around it.
- **Card ids**: base cards are titled `12 - Squid - Charakterkarte - Serie 3`, with a variant
  between type and series for some (`14 - Alex - Charakterkarte - Lava - Serie 3`,
  `58 - Villager - Charakterkarte - Holo - Serie 3`). Limited cards are
  `LE01 - Ender Dragon - Limitierte Karte - Serie 3` (`LE1`). There is no XXL card in the
  category. The numbers match sammel-ente's (27 of 27 shared numbers in the saved pages carry
  the same name, one typo: `10 - Trutle Skin Warrior`). The name is the text after the number up
  to the next spaced dash.
- **Price**: `<meta itemprop="price" content="0.55">` with `priceCurrency` `EUR` in each box,
  the gross price shown on the page (`0,55 €`). The analytics data in the page carries the net
  price (0.46) and is not used.
- **Stock**: each box has `<link itemprop="availability" href="https://schema.org/InStock">`
  and "Sofort verfügbar", so the listing page is enough and no product page is requested. All
  235 were `InStock`. Sold-out singles appear to be hidden: base numbers 2, 4, 8 and 104 and
  LE3, LE4 and LE6–LE12 are missing from the category, the site search shows only in-stock
  cards, and guessed product URLs of missing cards answer 404; no sold-out product page was
  found to save. A card that sells out therefore vanishes,
  and the run marks the stored listing unavailable. The value is matched by its schema.org
  name, case-insensitively, with or without the `http(s)://schema.org/` prefix: `InStock`,
  `LimitedAvailability` and `OnlineOnly` read as in stock, the other schema.org values
  (`OutOfStock`, `SoldOut`, `Discontinued`, `PreOrder`, …) as sold out. A box without
  availability or with an unknown value is a shop error, not stock information.
- **Pictures**: `<meta itemprop="image">` in each box, the `md` size (600w in the `<img>`
  srcset), on `www.collect-it.de` (`/media/image/product/<id>/md/<slug>.jpg`). The `<img src>`
  (the 200w `sm` size) is the fallback when the meta is missing; both are resolved against the
  shop.
- **Fixtures**: the pages carry a per-session CSRF token (`jtl_token`, also inside a base64
  `data:` script) and the shop's public reCAPTCHA site key; both are replaced by
  `REDACTED_…` placeholders in the saved pages.

## Not used

| Shop                                                                                                   | Sells singles                               | Why not used                                                                                                             |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [Kleinanzeigen](https://www.kleinanzeigen.de/s-lego-minecraft-karten/k0)                               | yes (private sellers)                       | No API, blocks bots, and its terms forbid scraping. Every alert carries a Kleinanzeigen search link instead.             |
| [stickerpoint.de](https://www.stickerpoint.de/blue-ocean-lego-minecraft-trading-cards-c-107_250.html)  | no, only packs, blisters, displays, bundles | Nothing to match against a missing card.                                                                                 |
| [stick-it-now.de](https://www.stick-it-now.de/)                                                        | no Minecraft at all                         | Old Panini / Topps stock only.                                                                                           |
| [Sammel-Ente trading and buying](https://sammel-ente.de/tausch-und-ankauf)                             | trade or purchase by e-mail                 | Not a shop page; handled by e-mail.                                                                                      |
| [mytradingcards.online](https://mytradingcards.online/marktplatz)                                      | private trades                              | A swap marketplace between collectors, not a shop; contact details are exchanged directly.                               |
| [Tauschgnom](https://www.tauschgnom.de/)                                                               | private trades                              | Swap board with old LEGO listings only.                                                                                  |
| [laststicker.com](https://www.laststicker.com/de/cards/blue_ocean_lego_minecraft_on_fire/)             | catalog only (once a day)                   | The catalog source: `/de/cards/<set>/` is fetched once a day (`catalog/laststicker.ts`), never `/cards/<set>/checklist`. |
| otto.de, Rossmann, Saturn / MediaMarkt                                                                 | no, only boosters / packs                   | Packs only.                                                                                                              |
| [BrickReport](https://www.brickreport.io/sets/tradingcard-18-minecraft-trading-cards-series-3-on-fire) | no                                          | Card database, not a shop.                                                                                               |
