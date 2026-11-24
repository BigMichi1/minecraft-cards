# Multiple collections: design

Date: 2026-11-19. Status: draft for approval.

## Intent

The maintainer collects several card sets, not only LEGO Minecraft series 3, and wants the bot to
watch each of them: LEGO Minecraft series 1, 2 and 3 (Blue Ocean) and Topps Formula 1 Turbo Attax
2026, with more to come (the next Turbo Attax season, other sets). Each set has its own card list
and numbering, its own shops, and every user keeps a separate missing list per set. Adding a new
set must be easy.

The maintainer manages the collections on laststicker.com and handed the how to the builder:
"it should just work now with multiple collections and be easy to extend for new collections".

## Goals

- A **collection** is the unit: its own catalog (card ids, names, kinds, reference pictures), its
  own shops to search, its own wanted lists, alerts naming it.
- Day one: `lego-minecraft-1`, `lego-minecraft-2`, `lego-minecraft-3`, `turbo-attax-2026`.
- Adding a collection whose shops are already supported means adding one definition file (plus a
  test and fixtures); no change elsewhere.
- Existing series 3 data, wanted lists, overrides and notification history carry over unchanged
  (they become `lego-minecraft-3`).
- laststicker.com is the reference of every collection: card list, names, kinds, variants and
  reference pictures (the maintainer's decision; see "Names and reference pictures").

## Non-goals

- Parallels (Turbo Attax Green /99, Gold /50 and so on): one card per checklist entry only.
- Syncing a user's laststicker account (no login); users paste lists, as today.
- Cardmarket, gridcards.co.uk and other shops without German single-card stock.
- Collections defined at runtime (config file, database, `/admin`): definitions live in code.

## Anti-goals (a failure even if it works)

- An alert for a card of another collection (a series 1 #3 "Comic Steve" sent to someone missing
  series 3 #3). A false id sends a false DM; when unsure, give no id.
- A shop or catalog error that marks stored listings unavailable (the existing Review focus rule,
  now per shop and collection).
- Hammering laststicker or a shop, or reading paths a robots.txt forbids.
- A series 3 regression: every existing test keeps passing, adapted only for the collection key.

## Constraints

- Everything in `CLAUDE.md` still holds: Mise tasks, a test next to every source file, POSIX `sh`,
  Conventional Commits with sign-off, epoch-ms timestamps, the shop User-Agent, 20 s timeout and
  1500 ms between page requests of one host, `validUrl` before any discord.js builder.
- laststicker: robots.txt allows `/de/cards/<set>/` and `/i/cards/…`; it forbids
  `/cards/*/checklist`, `/cards/preview/`, `/cards/s1/`, `/cards/s2/`, `/de/rules`, which the bot
  never requests. It answers our honest User-Agent with 200 (a generic fetcher got 403). Same UA,
  timeout and 1500 ms pacing as the shops.
- Discord: slash command option choices are limited to 25, which is plenty for collections.

## Approaches

1. **One definition per collection, in code (chosen).** `src/bot/collections/<id>.ts` holds the
   collection's id, display name, laststicker set, card id rule and, per shop, the category URL
   and title rules. Shop parsers are shared and run once per (collection, shop). A new set is one
   file and its tests; a new shop is a new parser. Typed, tested, reviewed like any change.
2. **Collections in a config file or the database, editable without deploy.** Rejected: the
   title rules (series words, pick lists, eBay forms) are code; describing them as data needs a
   rule language that is harder to test, and a bad entry sends wrong DMs.
3. **One bot instance per collection.** Rejected: users juggle several bots, eBay is searched once
   per instance, and every fix needs several rollouts.

The maintainer handed the choice to the builder; approach 1 is the builder's call.

## Design

### Collection registry

`src/bot/collections/types.ts` defines `CollectionDefinition`:

- `id`: stable slug (`lego-minecraft-3`), stored in the database; never renamed.
- `name`: display name (`LEGO Minecraft Serie 3 "On Fire"`, `Topps F1 Turbo Attax 2026`).
- `laststicker`: the set path on laststicker (`blue_ocean_lego_minecraft-1`).
- `cardIds`: the collection's id rule: `normalize(raw): CardId | null` and `compare(a, b)`.
  Minecraft keeps today's rule (`12`, `LE8`, `XXL1`). Turbo Attax adds prefixes `LE`, `GG`,
  `GU`, `SUN`, `BG` (`GU7`) and the relic codes `MR-HAM` and `RR-ALB` (two letters, a dash, three
  letters, uppercase). Card ids stay canonical strings and are unique only within a collection.
- `shops`: per shop, that shop's settings for this collection (below). A collection lists only
  the shops that sell it.
- `ebay`: queries and title rules (below), or absent.

`src/bot/collections/index.ts` exports `COLLECTIONS` (all definitions, in display order) and
`collectionById`. A test checks ids are unique and slug-shaped, and every shop config names a
known shop. All collections are enabled; there is no env switch (the builder may add one later
if a collection must be paused).

Adding a collection (documented in `docs/collections.md`): add the definition file, add it to
`COLLECTIONS`, add shop fixtures and the definition's test, run `/admin catalog sync`.

### Database

One migration (`db:generate`):

- `cards`: primary key becomes (`collection`, `card_id`). New columns: `kind` text (laststicker's
  section, e.g. `Skin Karte`, `Puzzlekarte`, `Limited Edition`), `variant` text (laststicker's
  type, e.g. `Basis Karte`, `Neon Karte`), `reference_source` (`laststicker` | `shop`).
- `wanted_cards`: key (`discord_id`, `collection`, `card_id`).
- `listings`: new `collection` column, not null. A listing belongs to exactly one collection; the
  same URL appearing in two collections' searches is one listing of the first collection that
  claims it (eBay dedup, below). `url` stays unique.
- `listing_cards`: card ids are read in the listing's collection (no extra column needed; joins
  go through `listings.collection`).
- `listings.picture_card_id` likewise in the listing's collection.
- `reports`, `notifications`, `admin_alerts`, `image_embeddings`: unchanged.
- Migration backfill: every existing row gets `lego-minecraft-3`.

Every manager function that takes a card id takes a collection too. Query helpers that joined on
`card_id` alone join on (`collection`, `card_id`).

### Catalog from laststicker

`src/bot/catalog/laststicker.ts` reads `https://www.laststicker.com/de/cards/<set>/`:

- The checklist table `#checklist`: per row number (`1`, `LE26`, `XXL1`), name, section (kind)
  and type (variant). Puzzle rows carry the piece in a nested `<div>` after the name
  (`Entdecke die Oberwelt` + `1`); the name stored is `Entdecke die Oberwelt 1`. Every row must
  parse; a row that does not, or a table that is missing, is a `CatalogLayoutError` and changes
  nothing.
- The set id from the `cards_tooltip` element (`rel="tooltip10289"` → `10289`).
- Reference picture URL: `https://www.laststicker.com/i/cards/<set id>/<lowercase number>.jpg`
  (`le26.jpg`, `xxl1.jpg`; uppercase is a 404). The picture is fetched by the matcher as today
  (bounded `downloadImage`, embedding cache by URL). A card whose picture answers 404 has no
  laststicker scan (Minecraft series 1 shows 92 % scanned): its reference falls back to the
  shop picture where the collection names a reference shop (sammel-ente for Minecraft), else
  `no_reference`.
- Card ids go through the collection's `normalize`; a number it rejects is a
  `CatalogLayoutError` naming it (a checklist the id rule does not cover is a definition bug).

Catalog sync (`catalogManager.syncCollection(collection, rows)`): inserts new cards, updates
kinds and variants, sets names and laststicker reference URLs where the collection's sources say
so (next section), and never deletes a card silently. A card that
vanished from laststicker is kept and reported in the admin DM (`/admin catalog sync` reply and a
throttled alert), as removing it would drop it from wanted lists. Puzzle cards are cards whose
kind is `Puzzlekarte` (sticky `puzzle_seen` as today). The placeholder-picture rule stays for
the shop fallback pictures.

When: once at start for any collection with an empty catalog, then once a day per collection (the
scheduler's daily slot), and on `/admin catalog sync [collection]`. A sync reads one page per
collection; pictures are fetched lazily by the matcher, which already paces and caches them.

The starter catalog (`STARTER_CHECKLIST`) and `/admin catalog import` remain as a fallback for a
collection laststicker cannot serve: import takes a collection option and a pasted laststicker
checklist (the maintainer pastes from the site; the Turbo Attax paste of 2026-11-19 lacked #135,
which the synced list includes).

### Cards laststicker is missing

laststicker's checklist can lack a card (Turbo Attax 2026 #135, missing there on 2026-11-19).
The admin adds such a card by hand:

- `/admin catalog add collection:<c> card:<id> name:<name> [picture:<url>]`: the id must pass
  the collection's id rule; the picture URL, when given, must pass `validUrl` and is used as the
  reference (else the shop fallback or `no_reference`, as for an unscanned card). The card is
  stored with `cards.source` = `manual`.
- The laststicker sync never deletes, renames or re-pictures a manual card. If laststicker later
  lists the same id, the card stays manual, and the sync reports it once in the admin DM ("now on
  laststicker: #135 …") so the admin can turn it over with `/admin catalog release` (the card
  becomes `laststicker`-sourced; its name and picture follow laststicker from the next sync).
- `/admin catalog edit collection:<c> card:<id> [name:] [picture:]` corrects a manual card;
  `/admin catalog remove collection:<c> card:<id>` removes a manual card only, and only after a
  confirm button that names how many users have it on their missing list (as today's catalog
  import preview does).
- Users can put a manual card on their missing list like any other; `/missing status` shows it.
- Cards from laststicker are `cards.source` = `laststicker` (column added by the migration;
  existing series 3 cards start as `laststicker` and are confirmed by the first sync; a series 3
  card the first sync does not find is reported, not removed, as for any vanished card).

### Names and reference pictures

laststicker is the reference of every collection (the maintainer's decision), Minecraft included:

- Names, kinds, variants and the reference picture of every card come from the laststicker sync.
  sammel-ente's scrape no longer writes names or references (`updateNamesAndReferences` goes;
  its listings stay ordinary listings with their own picture and price).
- Fallback picture: a card laststicker has no scan for (404 on its picture) uses the newest shop
  picture of the same collection and card from sammel-ente, when the definition names it
  (`referenceFallbackShop: 'sammel-ente'` for Minecraft), with today's placeholder rules
  (`_leer.`, one picture for several cards). Else `no_reference`. `cards.reference_source`
  (`laststicker` | `shop`) records which one is in use.
- sammel-ente listings lose the `reference` match status: they start `pending` and are compared
  like every other shop's listings. The `reference` status value is dropped from new rows (the
  migration resets existing ones, below).
- Puzzle cards come from laststicker's kind `Puzzlekarte` (sticky `puzzle_seen` as today); the
  "Puzzlekarte" name rule goes, since laststicker names puzzle cards by picture and piece
  ("Entdecke die Oberwelt 1").
- The series 3 eBay name check (PR #22) reads laststicker's names. Its tests use the series 3
  names of 2026-11-24 (laststicker and sammel-ente give the same names), plus two made-up names
  for title forms; step 2 re-runs the eBay fixture with laststicker's series 3 names and records
  the listings that change.

**Threshold measurement (step 2, before the switch).** Compare laststicker scans with shop
pictures (sammel-ente, collect-it, eBay) of the same and of neighbouring cards on series 3, and
record the scores in `docs/image-matching.md` as for the current threshold. If same-card and
different-card scores no longer separate at `IMAGE_MATCH_THRESHOLD`, or the twin or
`DECISION_GAP` rules stop holding, set new values from that measurement (never guessed) before
the switch ships. If no value separates them, the PR stops and reports the numbers to the
maintainer rather than shipping a worse matcher.

**The switch re-matches once.** When step 2 deploys, every listing that is not admin-mapped and
not a bundle goes back to `pending` (a migration, as `0003` did): its status and
`picture_card_id` were decided against the old references. The next run compares all of them
before it sends anything; notifications stay recorded per listing and availability period, so
nobody is notified twice. Mismatch notes that result are throttled as today (per listing and
picture card, once a day); the admin gets one summary line of how many changed instead of one
note per listing for that first run (`/admin run` reply and a single DM).

Later reference URL changes (a new scan on laststicker) keep today's rule: the cards whose
reference changed have their `mismatch` listings compared again, and `no_reference` listings are
retried every check.

### Shops per collection

Each adapter becomes a factory taking the collection's shop settings; `adapters.ts` builds one
adapter per (collection, shop) from `COLLECTIONS`. The runner runs them in collection order, then
shop order. Shop requests to one host stay sequential and paced, also across collections.

| Collection       | sammel-ente           | collect-it                                                           | blue-ocean                                                           | eBay |
| ---------------- | --------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- | ---- |
| lego-minecraft-1 | `/Minecraft/Serie-1/` | `/sammelwelt/sammelkarten/lego/minecraft/serie1/Einzelkarten`        | `/lego/lego-minecraft/trading-card-collection-serie-1/`              | yes  |
| lego-minecraft-2 | `/Minecraft/Serie-2/` | (none sells singles)                                                 | `/produkte/lego/lego-minecraft/trading-card-collection-boom-bastic/` | yes  |
| lego-minecraft-3 | as today              | as today                                                             | `…/trading-card-collection-on-fire/` (singles moved there)           | yes  |
| turbo-attax-2026 | (none)                | `/sammelkarten/formel1/Topps-Turbo-Attax-Formel-1-2026/Einzelkarten` | (none)                                                               | yes  |

Per-shop settings and parser changes:

- **sammel-ente**: category URL, series label in titles (`LEGO Minecraft Serie 1 | #001 Steve`).
  Ids from `#001`, `#LE008`, `#XXL001` (series 1 LE codes have 2 digits, series 2 have 4; the
  parser normalizes both). Puzzle packs and boosters stay skipped. Sold-out cards stay listed as
  unavailable, as today.
- **collect-it**: category URL and title pattern per collection. Minecraft series 1 titles:
  `1 - Steve - Skin Karte - Serie 1`, `LE10 - Skelett - Limitiere Karte - Serie 1`,
  `XXL 1 - … - Serie 1`; Turbo Attax: `4 - Lando Norris - 2026`, `GG8 - … - 2026`,
  `MR-HAM - … - 2026`. The title's collection marker (`Serie 1`, `2026`) must match the
  definition, else the item is skipped (counted). All walk rules (page total, `rel="next"`, full
  pages, canonical link) stay as they are.
- **blue-ocean**: category URL, card id from the URL suffix as today, plus the title marker per
  collection (`TCC 1`, the Boom-Bastic category's own list, `On Fire`). The mixed category with
  stickers (`Nummer 001 I LEGO® Minecraft Sticker`) is not used. A product whose title number and
  URL suffix disagree keeps today's `idConflict` handling.
- **eBay**: see below.

Shop errors and alerts (eBay excepted, see below) are keyed per (shop, collection) (`shop:collect-it:lego-minecraft-1`), and
a failing fetch leaves only that (shop, collection)'s stored listings untouched. `/admin status`
lists results per collection and shop.

### eBay

One adapter run covers all collections, so items found by several queries are fetched once:

- Each collection names its queries (`lego minecraft karten serie 1`, `turbo attax 2026`, …).
- Each item's title is classified by the collections' **series markers**: Minecraft series 1
  (`Serie 1`, `Series 1`, `TCC 1`), series 2 (`Serie 2`, `Boom-Bastic`), series 3 (`Serie 3`,
  `On Fire`, today's pattern), Turbo Attax 2026 (`Turbo Attax` and `2026`, and no other year).
  A title matching exactly one collection belongs to it; none or several gives no ids
  (`skippedExcluded`, reason `no collection` / `several collections`).
- The title id forms, `COUNT_WORDS`, pick-list, range and variation rules apply as today, read
  with the collection's id rule. The series-1/2 exclusion in today's series 3 rules becomes the
  general "exactly one collection" rule.
- The name check for titles without a series word (`nameMatchedCardIds`, PR #22) stays only for
  `lego-minecraft-3`, as today. It is not extended to other collections: names repeat across
  series ("Steve" is in all three), so such a title cannot be placed.
- Turbo Attax title forms to read: `No. 261`, `Nr. 261`, `#261`, `LE 11`, `Nr. LE19`, `GG8`,
  `MR-HAM`. Parallel words (`Pink`, `Parallel`, `Refractor`, `/99`, `Green`, `Gold` next to a
  base number, `SuperFractor`) give no id: they are other cards than the checklist's.
- Picture candidates (rule 4, a title naming no card) stay series 3 only.
- Errors: as today, any failing or malformed query fails the whole eBay run, so no collection's
  eBay listings are touched (an item found by one collection's query may belong to another, so a
  narrower scope could mark real listings unavailable). One alert key `shop:ebay`. A cut search
  still alerts (`shop-truncated:ebay`) and the run goes on, as today.

### Matcher

- The reference set is per collection: a listing is compared with its own collection's
  references only. `referenceCatalog(collection)`; the per-run reference cache is keyed by
  collection.
- The rules (decided, mismatch, twins, puzzles, `TWIN_SIMILARITY`, `DECISION_GAP`) stay, each
  within a collection. Twins and the complete-reference-set condition are per collection.
- laststicker scans carry a small watermark; the threshold `IMAGE_MATCH_THRESHOLD` is checked
  against them during implementation with a recorded comparison (as in
  `docs/image-matching.md`) on series 3, where sammel-ente and laststicker pictures both exist.
  If the scores shift, the threshold is re-measured, not guessed.
- A collection without any usable reference (Turbo Attax cards laststicker has not scanned)
  works as today's `no_reference`: alerts go out marked unconfirmed, picture never decides.

### Commands

- **Moving a listing to another collection**: `/admin map` takes a `collection` option. Mapping a
  listing sets its collection and card ids and its `manual_override`; a rescrape never changes
  either of an overridden listing (today's rule, extended to the collection). The admin note for a
  `wrong_series` report names this command. An unmapped listing follows its title on every
  rescrape: if the title now places it in another collection (or none), its collection and card
  ids change (or it is excluded and marked unavailable) like any title-derived card id today.
- `/missing set|add|remove|list|clear|status` get a required `collection` option (choices from
  `COLLECTIONS`). The list parser uses the collection's id rule; unknown tokens still change
  nothing and are named. A pasted laststicker list (header line included) is accepted, as today.
- `/stock` and `/card` get the `collection` option; `/card` with a collection and a card id.
- `/admin map`, `/admin catalog import|sync`, `/admin run`, `/admin status`: collection option
  where they act on cards or listings; `/admin run` runs all collections.
- `/help` lists the collections.
- A user's status (`/missing status`) is per collection.
- When a user has a missing list in only one collection, the commands still require the option
  (explicit beats a guessed default; Discord's choice list makes it one click). The builder may
  revisit after use.

### Notifications

- Alerts name the collection in the embed title (`Topps F1 Turbo Attax 2026 · #4 Lando Norris`).
- Batching, limits and the per-listing/availability record stay as they are, across all
  collections of a user (one run, one batch of at most 25).
- The reference thumbnail stays attached, now the laststicker scan with its watermark (the
  builder's call: the maintainer left it open and the watermark credits the source).

### Rollout in steps

Each step is its own PR, reviewed with the pr-review-toolkit, and leaves the bot working:

1. Collection key everywhere, registry with `lego-minecraft-3` only; migration backfill; no
   behaviour change (commands accept and default nothing yet: the option is added with one
   choice).
2. laststicker as the reference for `lego-minecraft-3`: catalog sync, manual cards
   (`/admin catalog add|edit|remove|release`), threshold measurement, sammel-ente listings
   compared like any shop, the one-time re-match.
3. `lego-minecraft-1` and `lego-minecraft-2`: definitions, shop settings, eBay classification.
4. `turbo-attax-2026`: id rule, collect-it Turbo Attax titles, eBay title forms.
5. `docs/collections.md` (how to add one) and doc updates (`shops.md`, `image-matching.md`,
   `configuration.md`, `CLAUDE.md` decisions: "the sammel-ente listing picture is the image
   reference" becomes "laststicker is the reference", and the puzzle rule changes).

## Decided by the maintainer

- The admin can add a card the reference list misses (Turbo Attax #135), per collection.
- laststicker is the reference for names and pictures in every collection, Minecraft included.
- Collections: LEGO Minecraft series 1, 2, 3 and Topps F1 Turbo Attax 2026; each with its own
  shops, ids and missing lists; easy to add more.
- No parallels.
- laststicker is the reference list, including pictures; #135 belongs to the Turbo Attax list.
- The builder decides the how.

## Builder's calls (marked for the maintainer to check)

- Approach 1 (definitions in code).
- Collection ids as slugs; all collections enabled.
- `collection` option required on every command.
- Reference thumbnail in DMs is the laststicker scan.
- laststicker sync daily, never deleting cards silently.
- sammel-ente's picture is the fallback for Minecraft cards laststicker has not scanned.
- The threshold is measured on laststicker scans before the switch; new values only from that
  measurement; no value that separates them means the PR stops and reports.
- The switch re-matches every unmapped, non-bundle listing once, with one summary line for the
  admin instead of a wave of mismatch notes.
- A wrong-collection listing is fixed with `/admin map … collection:`; unmapped listings follow
  their title.
- A failing eBay query leaves all collections' eBay listings untouched (as today).
- eBay: one run for all collections, titles placed by series markers, the name check kept for
  series 3 only.
- Manual cards are never touched by the sync; handing one back to laststicker is an explicit
  admin step.
- Rollout in five PRs.

## Notes from PR 1 for the later steps

Found in the review of PR 1 (collection key), to settle in the step that needs them:

- `cards.type` (`CARD_TYPES`: base, LE, XXL) is Minecraft-only. With per-collection id rules
  (step 4, Turbo Attax `GU7`, `MR-HAM`) the type comes from the collection's rule; do not widen
  `CardType` into a bag of every collection's kinds.
- The run summary, a shop's recent peak and the shop alert keys (`shop-error:<shop>`, ...) are
  keyed per shop. `createShopAdapters` refuses a second adapter of one shop until they are keyed
  per (shop, collection) (step 3).
- `/admin map` refuses to move a listing to another collection: no run of its shop would update
  it there. Step 3 decides moves together with title-driven collection changes.
- Shop parsers (`ShopFetcher`) still read series 3 rules; step 3 gives them per-collection
  settings (typed per shop, a collection lists only the shops that sell it).
- The eBay name check (`nameMatchedCardIds`) accepts a series 3 name beside its number even when
  series 1 or 2 has the same name at that number (`Karte 104 - Ghast`: series 3 #104 is Ghast, PR
  #22 assumed otherwise). Step 3, with the series 1 and 2 catalogs loaded, places such a title by
  name only when no other series has that name at that number.

## Notes from PR 2a for the later steps

- PR 2b (references from laststicker scans): the reference picture depends on the card's
  source: a manual card keeps the admin's picture (`referenceImageUrl`), a laststicker card uses
  its scan (`laststickerImageUrl`, read by `catalogManager.laststickerPicture`) with sammel-ente's
  as the fallback. Add one source-aware accessor instead of reading the columns at each caller.
- Steps 3 and 4 (other id rules): `parseLaststickerPage` takes the collection's id rule
  (`normalize`); `syncCollection` still uses `cardType` and the section name `Puzzlekarten`,
  which become per-collection settings with the definitions.

## Notes from PR 2b for the later steps

- `cards.reference_source` is not stored: `catalogManager.referenceCatalog` derives each card's
  source (`ReferenceCard.source`: `laststicker`, `shop`, `manual`) from its columns
  (`laststicker_image_url`, `laststicker_scan_missing_at`, `shop_image_url`, and the admin's
  `reference_image_url`), so it cannot drift.
- The measurement (`docs/image-matching.md`, 2026-11-24) kept 0.78, 0.02 and 0.9. 17 series 3
  cards have no laststicker scan and use sammel-ente's picture; Turbo Attax cards without a scan
  and without a fallback shop are `no_reference` (spec "Matcher").
- The re-match keeps the old status in `listings.rematch_from` until the listing is compared
  again; listings that are unavailable or nobody wants keep it until they are compared. A final
  status, an admin map or a bundle clears it.
- Steps 3 and 4: a new collection with a laststicker set needs `referenceFallbackShop` only if a
  shop's pictures should stand in for missing scans.

## Notes from PR 3a for the later steps

- Step 3 is split: 3a (series 1 and 2 catalogs, sammel-ente and collect-it per collection, run
  results and alerts per (shop, collection)), 3b (eBay across collections: series markers,
  moving a listing to the collection its title names, the name rule for `Karte 104 - Ghast`),
  3c (blue-ocean's TCC categories, a new parser: `Nummer N I Name I LEGO Minecraft TCC 1`).
- laststicker: series 1 is `blue_ocean_lego_minecraft-1` (German names, section `Puzzlekarte`),
  series 2 `blue_ocean_lego_minecraft_tnt_boom_bastic` (no scans at all, a bare `XXL`). The
  definition's `laststicker.scans: false` and `numberAliases` cover them; a puzzle card is a
  section starting with `Puzzlekarte`.
- The run summary keeps series 3 in `shops` (every stored row) and the other collections in
  `collections`; `runManager.shopEntry` reads both.
- Shop alert keys are per (shop, collection); eBay's one run keys its fetch error and cut
  searches once (`shop-error:ebay`, `shop-truncated:ebay`, 3b).
- Step 4 (Turbo Attax): its id rule goes into the definition (`normalize` for the laststicker
  parser, the shops' title patterns), and `collect-it` settings already take a series label.

## Notes from PR 3b for the later steps

- eBay's one run serves every collection with `shops.ebay` (queries and a series marker regex in
  the definition); `classifyTitle` places a title by every known marker, and the fetcher tags
  each listing with its collection (`Listing.collection`). An adapter covering several
  collections (`ShopAdapter.collections`) is stored per collection by the runner, and its
  failure alerts once under the shop (`shop-error:ebay`), as designed above.
- An unmapped eBay listing whose title names another collection moves there
  (`upsertFromRun(…, { moveFrom: true })`); admin-mapped ones stay. Other shops keep the
  foreign-listing alert.
- Series 3's name check refuses a name series 1 or 2 has at that number; picture candidates and
  the name check stay series 3 only. Step 4 (Turbo Attax) adds its marker (`Turbo Attax` and
  `2026`) and its id rule's title forms.

## Left to the builder

- Exact module layout inside each adapter, the migration's SQL (generated), names of helpers.
- The series markers' exact regexes, with fixtures of real titles per collection.
- Whether the shop settings are plain data or small functions per collection.
- Fixtures: laststicker set pages (Minecraft 1, Turbo Attax 2026), sammel-ente series 1 and 2
  pages, collect-it Minecraft 1 and Turbo Attax pages, blue-ocean series 1 and 2 pages, eBay
  titles per collection. Fetched once with the bot's User-Agent and trimmed.
