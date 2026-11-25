# minecraft-cards-bot

A Discord bot that checks shops (sammel-ente, blue-ocean, collect-it, euro-soccer-cards, optionally eBay) every hour
(configurable, `CHECK_INTERVAL_MINUTES`) for trading card availability (LEGO Minecraft, Topps F1
Turbo Attax) and DMs users about the cards they are missing. Adding a card set is described in
`docs/collections.md`. A
picture comparison against the card's laststicker scan (sammel-ente's picture where laststicker
has none) marks a listing as confirmed.

Users keep one list per card collection (`lego-minecraft-1`, `lego-minecraft-2`,
`lego-minecraft-3` and `turbo-attax-2026`: LEGO Minecraft series 1, 2 "TNT Boom-Bastic" and 3
"On Fire", and Topps F1 Turbo Attax 2026, which collect-it, euro-soccer-cards and eBay sell); the card
commands (`/missing *`, `/stock`, `/card`, `/admin map`, `/admin catalog import`) take a
required `collection:` option. Users manage their list with
`/missing set|add|remove|list|clear|status`; the admin runs `/admin` (`map`, `clear`, `status`,
`run`, `catalog import|sync|add|edit|remove|release`). The catalog (card list and names) is
synced from laststicker once a day; `catalog add` adds a card laststicker lacks. `/help`
explains the rest.

- `/stock collection:<c> [only:all|missing|in-stock]` pages through every card of that collection
  (one row each, one column per shop that sells the collection): `x` in stock, `-` not available (held back and paused
  count as not available), `?` not checked, `n/a` not enabled. ◀ ▶ buttons turn the pages; each
  page fits in one message.
- `/card collection:<c> number:<id> [shop:<shop>]` shows one card per shop (the best listing, the
  offer count) with its reference picture, an `Open <shop>` button to the cheapest offer of each
  shop (a picture-backed single first; a bundle or unconfirmed picture only when there is none;
  prices compared in one currency) and a Kleinanzeigen search; `shop:` limits it to one shop.

`/missing status` shows the last check per shop (with "data as of" for a shop whose check failed
or did not run), then a table with one row per missing card and one column per shop that sells the collection:

- A cell is a price, `in stock` (no price), `sold out`, `ended`, `paused`, `–` (the shop's last
  check succeeded and lists no such card), `?` (that check failed or never ran and nothing is
  stored) or `n/a` (the shop is not enabled).
- Markers (ASCII, so the columns stay aligned): `*` (⏱) older than the last check, `!` (⚠)
  picture unconfirmed, `+` bundle. A legend line under the table names only the markers that
  appear.
- Every in-stock cell with a valid listing URL carries a reference `[1]`, `[2]`, … (numbered row
  by row, left to right). An embed under the message links each reference to its listing:
  `[1] [#140 Wither · blue-ocean · 0,80 €](url)`.
- Whole rows are kept within Discord's 2000 characters, the rest counted as "… and N more
  cards"; links over the 4096 characters of the embed are counted as "… and N more links".

## Documentation

- [Development](docs/development.md): setup, tasks, rules, CI
- [Configuration](docs/configuration.md): every environment variable
- [Image matching](docs/image-matching.md): model choice, threshold measurement, caveats
- [Deployment](docs/deployment.md): Docker image, Compose, first start
- [Shops](docs/shops.md): which shops were checked, which sell single cards, which the bot reads
- [Design](docs/superpowers/specs/2026-11-17-minecraft-cards-bot-design.md) and
  [implementation plan](docs/superpowers/plans/2026-11-17-minecraft-cards-bot.md)
- [CLAUDE.md](CLAUDE.md): architecture and invariants for contributors and Claude Code
- [DCO.md](DCO.md): sign-off requirement

## Quick start

All tasks run through the vendored Mise launcher:

```bash
./bin/mise install
./bin/mise run install
cp .env.example .env        # set DISCORD_TOKEN and BOT_ADMIN_ID
./bin/mise run model:download
./bin/mise run dev
```

## License

MIT, see `LICENSE`.
