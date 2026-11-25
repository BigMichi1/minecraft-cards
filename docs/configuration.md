# Configuration

The bot reads its settings from environment variables once at startup (`src/bot/config.ts`).
A missing or invalid value stops the bot with a message naming the variable, never its value.
`DB_PATH`, `MIGRATIONS_PATH` and `LOG_LEVEL` are read by `src/bot/database/db.ts` and
`src/bot/utils/logger.ts` when they load. `.env.example` documents each one.

| Variable                 | Default                                 | Meaning                                                                                                                                                                           |
| ------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`          | required                                | Bot token from the Discord developer portal                                                                                                                                       |
| `BOT_ADMIN_ID`           | required                                | Discord user id of the admin: `/admin`, catalog commands and sync alerts, shop-error and wrong-card report DMs                                                                    |
| `DISCORD_GUILD_ID`       | unset                                   | Register slash commands in this guild (instant); unset registers globally (up to an hour)                                                                                         |
| `DB_PATH`                | `./data/cards.db`                       | SQLite database file (`/app/data/cards.db` in the image)                                                                                                                          |
| `MIGRATIONS_PATH`        | `src/bot/database/migrations`           | Migration folder; set in the Docker image                                                                                                                                         |
| `CHECK_INTERVAL_MINUTES` | `60`                                    | Minutes between shop checks, at most 35791 (a timer's limit). Keep it at an hour or more                                                                                          |
| `EBAY_CLIENT_ID`         | unset                                   | eBay Browse API application keyset: set both, or neither (eBay off); only one is a startup error                                                                                  |
| `EBAY_CLIENT_SECRET`     | unset                                   |                                                                                                                                                                                   |
| `IMAGE_MODEL`            | `Xenova/dinov2-small`                   | Hugging Face model for the picture check                                                                                                                                          |
| `IMAGE_MATCH_THRESHOLD`  | `0.78`                                  | Cosine similarity (0 to 1, exclusive) that confirms a listing, and the bar a picture must reach to decide its card (`docs/image-matching.md`); re-measure when changing the model |
| `MODEL_CACHE_DIR`        | `./models` (`/app/models` in the image) | Where model files are cached                                                                                                                                                      |
| `LOG_LEVEL`              | `info`                                  | `error`, `warn`, `info`, `debug` or `trace`                                                                                                                                       |

Secrets (`DISCORD_TOKEN`, `EBAY_CLIENT_SECRET`, eBay access tokens) are never logged. Never
commit a real `.env`; the secret scan in CI rejects tracked env files.

Shop requests use the User-Agent `minecraft-cards-bot/1.0 (+hourly stock check)`, a 20 s
timeout, and 1500 ms between page requests of one shop.

Collections and their shops are not configured here: they are definitions in code (spec
"Non-goals"), added as `docs/collections.md` describes.
