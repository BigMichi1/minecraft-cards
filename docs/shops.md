# Shops

Which shops were checked for LEGO Minecraft TCC series 3 ("On Fire") single cards, whether they sell
them, and whether the bot can read them. Checked 2026-11-17 / 2026-11-18. Re-check when a shop
changes or a new one is suggested.

## Used by the bot

| Shop                                                                                                  | Sells singles                   | Readable                         | How the bot reads it                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [shop-sammel-ente.de](https://shop-sammel-ente.de/Minecraft/Serie-3/)                                 | yes (all 228 + LE + XXL1)       | yes                              | Shopware storefront HTML, `?p=N` pages. Card id from the title (`#012 Squid`). Its pictures are the image reference for every other shop.                                              |
| [blue-ocean.de](https://www.blue-ocean.de/produkte/lego/lego-minecraft/lego-minecraft-sticker-cards/) | yes (the publisher's own shop)  | yes                              | Shopware + Nuxt HTML, `?p=N` pages. Card id from the product URL suffix (`…-2dd00088-12`); the title's "Nr." is wrong. Only "On Fire" titles count; series 1 and 2 share the category. |
| [collect-it.de](https://www.collect-it.de/sammelkarten/lego/minecraft/serie-3/Einzelkarten)           | yes (235 singles)               | yes                              | JTL shop HTML, 30 per page (`…/Einzelkarten_sN`). Card number at the start of the title (`12 - Squid - Charakterkarte - Serie 3`); stock via schema.org `availability`.                |
| eBay (`EBAY_DE`)                                                                                      | yes (private and trade sellers) | yes, via the official Browse API | Needs `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`; disabled until the eBay developer account is approved. Card ids from the title.                                                         |

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
