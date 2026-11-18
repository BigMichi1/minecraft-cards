# minecraft-cards-bot

A Discord bot that checks shops (sammel-ente, blue-ocean, collect-it, optionally eBay) every hour
(configurable, `CHECK_INTERVAL_MINUTES`) for
Minecraft sticker card availability and DMs users about the cards they are missing. A
picture comparison against the sammel-ente card image marks a listing as confirmed.

Users manage their list with `/missing set|add|remove|list|clear|status`; the admin runs `/admin`
(`map`, `clear`, `status`, `run`, `catalog import`). `/help` explains the rest.

`/missing status` shows the last check per shop (with "data as of" for a shop whose check failed
or did not run), then a table with one row per missing card and one column per shop:

- A cell is a price, `in stock` (no price), `sold out`, `ended`, `paused`, `–` (the shop's last
  check succeeded and lists no such card), `?` (that check failed or never ran and nothing is
  stored) or `n/a` (the shop is not enabled).
- Markers: `⏱` older than the last check, `⚠` picture unconfirmed, `+` bundle. A legend line
  under the table names only the markers that appear.
- Every in-stock cell with a valid listing URL carries a superscript number (`¹ … ⁹ ¹⁰ ¹¹`,
  numbered row by row, left to right). An embed under the message links each number to its
  listing: `¹ [#140 Wither · blue-ocean · 0,80 €](url)`.
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
