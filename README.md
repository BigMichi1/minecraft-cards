# minecraft-cards-bot

A Discord bot that checks shops (sammel-ente, blue-ocean, optionally eBay) every hour
(configurable, `CHECK_INTERVAL_MINUTES`) for
Minecraft sticker card availability and DMs users about the cards they are missing. A
picture comparison against the sammel-ente card image marks a listing as confirmed.

Users manage their list with `/missing set|add|remove|list|clear|status`; the admin runs `/admin`
(`map`, `clear`, `status`, `run`, `catalog import`). `/help` explains the rest.

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
