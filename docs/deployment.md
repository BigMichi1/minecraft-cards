# Deployment

## Image

The Docker image is built by `Dockerfile` and published to
`ghcr.io/bigmichi1/minecraft-cards` by `.github/workflows/docker.yml` (tags `latest`, `main`,
release versions, `sha-<short>`); release images are signed with Cosign.

- **Build stage** installs the pinned toolchain through `bin/mise`, the locked dependencies, and
  downloads the image model into `/app/models` (needs network at build time).
- **Production stage** runs `bun run src/bot/bot.ts` rather than a compiled binary:
  `bun build --compile` cannot load the image model (see `docs/image-matching.md`). It holds the
  mise-installed Bun, production `node_modules` (`bun install --production --frozen-lockfile`),
  `src/bot` (with its migrations) and the model. It runs as the non-root user `bot` (uid 10001).
- The model is read from `/app/models` (`MODEL_CACHE_DIR`), so the container needs no access to
  Hugging Face. It still needs network access to Discord, the shops and (optionally) eBay.

The server is x86_64; the image has not been built for arm64.

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
not whether Discord is reachable. Shop failures, unparseable pages, a shop whose card listings
all read as unavailable (a changed stock marker) and an image model that failed to load reach
the admin as DMs.

## First start

Run `/admin catalog import` as the admin to load the card catalog, `/admin run` to check the
shops once, and `/admin status` to see the last run and the listings on hold after a report.
