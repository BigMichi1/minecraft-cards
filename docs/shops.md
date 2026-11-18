# Shops

Which shops were checked for LEGO Minecraft TCC series 3 ("On Fire") single cards, whether they sell
them, and whether the bot can read them. Checked 2026-11-17 / 2026-11-18. Re-check when a shop
changes or a new one is suggested.

## Used by the bot

| Shop                                                                                                  | Sells singles                   | Readable                         | How the bot reads it                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [shop-sammel-ente.de](https://shop-sammel-ente.de/Minecraft/Serie-3/)                                 | yes (all 228 + LE + XXL1)       | yes                              | Shopware storefront HTML, `?p=N` pages. Card id from the title (`#012 Squid`). Its pictures are the image reference for every other shop.                                                 |
| [blue-ocean.de](https://www.blue-ocean.de/produkte/lego/lego-minecraft/lego-minecraft-sticker-cards/) | yes (the publisher's own shop)  | yes                              | Shopware + Nuxt HTML, `?p=N` pages. Card id from the product URL suffix (`…-2dd00088-12`); the title's "Nr." is wrong. Only "On Fire" titles count; series 1 and 2 share the category.    |
| [collect-it.de](https://www.collect-it.de/sammelkarten/lego/minecraft/serie-3/Einzelkarten)           | yes (235 singles)               | yes                              | JTL shop HTML, 30 per page (`…/Einzelkarten_sN`), walked by `<link rel="next">`. Card id at the start of the title (`12 - Squid - …`, `LE01 - …`); price and stock from the listing page. |
| eBay (`EBAY_DE`)                                                                                      | yes (private and trade sellers) | yes, via the official Browse API | Needs `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`; disabled until the eBay developer account is approved. Card ids from the title.                                                            |

## collect-it.de details

Read from the saved pages of 2026-11-18 (`src/test/fixtures/collect-it-*.html`, fetched with the bot's
User-Agent):

- **Pages**: `…/Einzelkarten` is page 1, `…/Einzelkarten_sN` page N, 30 products per page; 235
  singles on 8 pages (25 on page 8). Each page but the last has `<link rel="next">`, and each
  page's canonical link names its own page. A page past the end (`_s9`, `_s99`) answers
  `301` to page 1, so there is no empty page that ends the list: the adapter follows
  `rel="next"` and stops when a page lacks it, or when the canonical link names another page
  than the one asked for (the shop shrank during a run).
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
  and the run marks the stored listing unavailable. `OutOfStock` (or no availability) would
  read as sold out, `InStock` and `LimitedAvailability` as in stock.
- **Pictures**: `<meta itemprop="image">` in each box, 600 px, on `www.collect-it.de`
  (`/media/image/product/<id>/md/<slug>.jpg`).
- **Fixtures**: the pages carry a per-session CSRF token (`jtl_token`, also inside a base64
  `data:` script) and the shop's public reCAPTCHA site key; both are replaced by
  `REDACTED_…` placeholders in the saved pages.

## Not used

| Shop                                                                                                   | Sells singles                               | Why not used                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Kleinanzeigen](https://www.kleinanzeigen.de/s-lego-minecraft-karten/k0)                               | yes (private sellers)                       | No API, blocks bots, and its terms forbid scraping. Every alert carries a Kleinanzeigen search link instead. |
| [stickerpoint.de](https://www.stickerpoint.de/blue-ocean-lego-minecraft-trading-cards-c-107_250.html)  | no, only packs, blisters, displays, bundles | Nothing to match against a missing card.                                                                     |
| [stick-it-now.de](https://www.stick-it-now.de/)                                                        | no Minecraft at all                         | Old Panini / Topps stock only.                                                                               |
| [Sammel-Ente trading and buying](https://sammel-ente.de/tausch-und-ankauf)                             | trade or purchase by e-mail                 | Not a shop page; handled by e-mail.                                                                          |
| [mytradingcards.online](https://mytradingcards.online/marktplatz)                                      | private trades                              | A swap marketplace between collectors, not a shop; contact details are exchanged directly.                   |
| [Tauschgnom](https://www.tauschgnom.de/)                                                               | private trades                              | Swap board with old LEGO listings only.                                                                      |
| [laststicker.com](https://www.laststicker.com/cards/blue_ocean_lego_minecraft_on_fire/)                | no (checklist and trading)                  | Behind a Cloudflare bot check. Used by hand as the official checklist for `/admin catalog import`.           |
| otto.de, Rossmann, Saturn / MediaMarkt                                                                 | no, only boosters / packs                   | Packs only.                                                                                                  |
| [BrickReport](https://www.brickreport.io/sets/tradingcard-18-minecraft-trading-cards-series-3-on-fire) | no                                          | Card database, not a shop.                                                                                   |
