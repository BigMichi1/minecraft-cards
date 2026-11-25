# Collections

A collection is one card set the bot watches: LEGO Minecraft series 1, 2 and 3, and Topps F1
Turbo Attax 2026 today. Each has its own catalog (card ids, names, reference pictures), its own
shops and its own wanted lists. Every card, wanted entry and listing belongs to one collection,
and card ids are unique only within it (`12` is another card in each).

A collection is a definition in code, `src/bot/collections/<name>.ts`. Its id (`turbo-attax-2026`)
is stored in the database: it is never renamed and never removed.

## Adding a collection

1. **Add the id** to `COLLECTION_IDS` in `src/bot/collections/ids.ts`. It must be a slug starting
   with a letter (`ids.test.ts` checks this). Display order is the list's order.
2. **Write the definition** (`CollectionDefinition` in `ids.ts`), with a test that pins it
   (`<name>.test.ts`). Its fields:
   - `id`: the new id.
   - `name`: the display name in commands and alerts (`Topps F1 Turbo Attax 2026`).
   - `cardIds`: the card id rule (`CardIdRule` in `src/bot/cards/cardId.ts`). Use
     `MINECRAFT_CARD_IDS` (`12`, `LE8`, `XXL1`) or `TURBO_ATTAX_CARD_IDS` (`12`, `LE4`, `GG8`,
     `MR-HAM`), or add a rule there: `prefixes` before a number (uppercase letters) and
     `codes`, two-letter families of three-letter codes (`MR-HAM`). Lists, commands, the
     laststicker sync and the shop titles read the collection's ids with it, so an id outside it
     is refused.
   - `kleinanzeigen`: the Kleinanzeigen search words before the card id, lowercase and joined by
     dashes (`turbo-attax-2026`).
   - `laststicker`: `{ set }`, the set path on laststicker.com (`/de/cards/<set>/`). Optional:
     `scans: false` when laststicker has no scans of the set, and `numberAliases` for a checklist
     number laststicker writes differently (series 2's bare `XXL` is `XXL1`). A section starting
     with `Puzzlekarte` makes a puzzle card.
   - `referenceFallbackShop` (optional): the shop whose listing picture is a card's reference when
     laststicker has no scan of it. Only sammel-ente stores such pictures. Without it, an unscanned
     card has no reference (`no_reference`, see `docs/image-matching.md`).
   - `knownTwins` (optional): pairs of cards that show the same art.
   - `starterChecklist` (optional): a checklist seeded into an empty catalog at start (series 3
     only, from before laststicker).
   - `shops`: one entry per shop that sells the collection (next section).
3. **Register it** in `DEFINITIONS` in `src/bot/collections/index.ts`. An id without a definition
   is a compile error.
4. **Set the shops.** Only the shops listed get an adapter, a column in `/missing status` and
   `/stock`, and a line in `/card`.
5. **Add fixtures and tests.** Save each page once with the bot's User-Agent
   (`minecraft-cards-bot/1.0 (+hourly stock check)`) into `src/test/fixtures/`:
   - the laststicker set page (trimmed to its checklist);
   - a category page per shop;
   - for eBay, a search answer of reviewed real titles, with ids and URLs replaced and no seller
     data.

   Then test each parser on them, and extend `collections/index.test.ts` (it lists the registry
   and the slash command choices).

6. **Check.** Run `./bin/mise run typecheck`, `lint` and `test`. The start checks below run in
   `shops/adapters.test.ts` through `createShopAdapters`.
7. **After deploy:**
   - the slash commands are registered at every start (`bot.ts`), so the new choice appears then;
   - the catalog comes from laststicker with the next check (`/admin catalog sync collection:<id>`
     loads it now);
   - a card laststicker lacks is added with `/admin catalog add collection:<id> card:<id> name:<name>`.

## Shops and their settings

| Shop              | Settings                                                                                               | Limits                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| sammel-ente       | `category` (absolute URL), `series: 'Serie N'` (named before the title's pipe)                         | LEGO Minecraft rule only                                                                                  |
| collect-it        | `category` (absolute URL), `series`: `Serie N` or a year (`2026`), the end of every title              | any rule; a category reads only its own kind of label                                                     |
| blue-ocean        | `productCode`, and optionally `categoryPath`, `picture`, `title`, `excludes`                           | LEGO Minecraft rule only; one walk serves every collection, so codes, paths and picture parts must differ |
| euro-soccer-cards | `category` (absolute URL ending with `/`), `slugSuffix` (`-turbo-attax-2026`, or `''`)                 | any rule; ids come from the product URL slug                                                              |
| eBay              | `queries`, `series` (a marker regex), `idForms` (`minecraft` or `turbo-attax`), `excludes`, `maxPages` | `idForms` must read the collection's rule; one run serves every collection                                |

How each shop is read, and why, is in `docs/shops.md` (the "Used by the bot" table, "Per
collection", "eBay details" and "collect-it.de details") and in the decisions in `CLAUDE.md`.

Settings are checked at start (`checkSettings`, `checkIdRule` and `checkDistinctBlueOcean` in
`src/bot/shops/adapters.ts`), and the bot refuses to start on any of these:

- a category on another host than its shop;
- a malformed id rule, or Kleinanzeigen words that are no lowercase slug;
- a series label of no readable kind;
- sammel-ente or blue-ocean on a collection without Minecraft's rule;
- eBay title forms reading another rule than the collection's;
- a `g` or `y` flag on a marker;
- an eBay page cap outside 1 to 50;
- a euro-soccer-cards slug suffix that is no lowercase slug, or a category without its `/`.

## When code is needed

Settings cover a collection whose shops are already supported. Two things need code:

- **A new id rule with eBay titles.** eBay reads titles with one of two readers (`idForms`:
  `minecraft` in `src/bot/shops/ebay.ts`, `turbo-attax` in `src/bot/shops/ebayTurboAttax.ts`). A
  rule of its own needs its reader, a new `idForms` value, its case in `readIdsIn` (`ebay.ts`) and
  in `FORM_RULES` (`adapters.ts`). Read the eBay decision in `CLAUDE.md` first: a false id sends a
  false DM, so a reader reads only forms that name a card outright.
- **A new shop.** It needs:
  - a parser and fetcher in `src/bot/shops/`, with its test and fixtures (a partial read is a
    `ShopLayoutError`, see the Review focus in `CLAUDE.md`);
  - its id in `SHOP_IDS` (`shops/types.ts`);
  - its settings type in `CollectionShops` (`collections/ids.ts`) and its case in `fetcherFor`
    (`adapters.ts`);
  - its host in `SHOP_HOSTS` (`adapters.ts`, the pacer) and its picture host in `IMAGE_HOSTS`
    (`matcher/embedder.ts`);
  - its labels in `SHOP_NAMES` (`notify/messages.ts`) and `SHORT` (`commands/stockPage.ts`).

  A `ShopId` missing from these maps is a compile error.

## Worked example

Topps F1 Turbo Attax 2026 was added by PR 4 and PR 4b (`docs/superpowers/plans/2026-11-25-collections-pr4-turbo-attax.md`):

- the definition `src/bot/collections/turboAttax2026.ts` and its test;
- a new id rule (`TURBO_ATTAX_CARD_IDS`) and eBay reader (`shops/ebayTurboAttax.ts`);
- collect-it settings with a year label;
- a new shop (euro-soccer-cards).
