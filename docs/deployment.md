# Deployment

## Image

The Docker image is built by `Dockerfile` and published to
`ghcr.io/bigmichi1/minecraft-cards` by `.github/workflows/docker.yml` (tags `latest`, `main`,
release versions, `sha-<short>`); release images are signed with Cosign.

- **Build stage** installs the pinned toolchain through `bin/mise`, the locked dependencies, and
  downloads the image model into `/app/models` (needs network at build time).
- **Production stage** runs `bun run src/bot/bot.ts` rather than a compiled binary:
  `bun build --compile` cannot load the image model (see `docs/image-matching.md`). It holds the
  mise-installed Bun, production `node_modules`
  (`bun install --production --frozen-lockfile --ignore-scripts`),
  `src/bot` (with its migrations) and the model. It runs as the non-root user `bot` (uid 10001).
- The model is read from `/app/models` (`MODEL_CACHE_DIR`), so the container needs no access to
  Hugging Face. It still needs network access to Discord, the shops and (optionally) eBay.

The server is x86_64; the image has not been built for arm64.

## Discord application

In the Discord Developer Portal, first open the **Installation** tab and set **Install Link**
to **None** (Discord refuses a private app that still has a default install link), save, then
turn off **Public Bot** on the **Bot** tab, so only you can add the bot to a server. Invite the
bot with the URL from **OAuth2 → URL Generator** (scopes `bot` + `applications.commands`). `/admin` is registered with the Administrator default permission (hidden
from other members); the bot still accepts it only from `BOT_ADMIN_ID`.

## Run

```sh
cp docker-compose.example.yml docker-compose.yml
mkdir -p data && sudo chown 10001:10001 data # SQLite volume, writable by the bot user
# set DISCORD_TOKEN and BOT_ADMIN_ID in .env
docker-compose up -d
docker-compose logs -f minecraft-cards
```

On start the log shows "Database migrations applied", the catalog and the model loading. The
database lives in the `./data` volume (`/app/data/cards.db`): back it up, it holds users'
missing lists and listing state.

Podman works the same way: `podman build -t minecraft-cards .`, then
`podman run --rm --env-file .env -v ./data:/app/data minecraft-cards`.

## Health

The container healthcheck is `pgrep -f "[b]ot/bot\.ts"` (the bracket keeps the check from matching itself): it reports whether the process lives,
not whether Discord is reachable. These reach the admin as DMs (each kind at most once a day):
shop failures and unparseable pages, a shop whose card listings all read as unavailable (a
changed stock marker), a shop returning less than half of its last successful count (a
pagination or markup change), a check run that failed, a run where every notification DM
failed, notifications that could not be built, failed slash command registration, and an image
model that failed to load. A wrong-card report whose admin DM failed is sent again with the
next check.

## First start

The starter catalog (228 base cards, LE1-LE22, XXL1) is seeded on the first start.
`/admin catalog import` is optional: use it when laststicker's checklist differs. Run
`/admin run` to check the shops once, and `/admin status` to see the last run and the
listings on hold after a report.
