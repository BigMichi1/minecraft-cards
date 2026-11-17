# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All tasks run through the vendored Mise launcher `./bin/mise` (it pins Bun, gitleaks, ripgrep and jq into `.mise/`, plus the maintainer's own `claude` and `python` tools, which the bot does not use). Do not call `bun run`, `npm`, or `npx` directly; if a task is missing, add it to `.mise.toml`.

```bash
./bin/mise run install       # bun install
./bin/mise run dev           # run bot from source (bun run --bun src/bot/bot.ts)
./bin/mise run typecheck     # bun check -p tsconfig.bot.json
./bin/mise run test          # bun test
./bin/mise run test:coverage # lcov -> coverage/lcov.info
./bin/mise run lint          # eslint src scripts
./bin/mise run lint:fix
./bin/mise run format        # syncpack + prettier
./bin/mise run format:check
./bin/mise run model:download # image model into ./models (once)
./bin/mise run docker-build  # production image (podman build works too)
./bin/mise run gitleaks      # secret scan
```

Extra args pass through: `./bin/mise run test src/bot/utils/async.test.ts`, `./bin/mise run test -t "name"`.

Database migrations are generated: edit `src/bot/database/schema/*.ts`, then `./bin/mise run db:generate`.

Commits: Conventional Commits, signed off (`git commit -s`). Hooks run gitleaks, eslint (check only: fix with `lint:fix` and stage), commitlint and a DCO check; never use `--no-verify`. Every non-test source file needs a matching `*.test.ts`, with these exemptions: `src/bot/bot.ts` (entrypoint wiring only; its logic lives in tested modules such as `lifecycle.ts`), `src/bot/database/schema/*.ts` (covered by the smoke test `database/db.test.ts`, which also covers `db.ts`), and the test helpers in `src/test/`.

## Architecture

Bun + TypeScript Discord bot (discord.js), SQLite through Drizzle. `src/bot/bot.ts` wires everything.

- `config.ts`: env parsing, fails fast with a message naming the variable.
- `cards/`: canonical card ids and the starter catalog.
- `shops/`: adapters for sammel-ente, blue-ocean and eBay behind one `ShopAdapter` interface.
- `check/`: `runner.ts` (one round for all users), `scheduler.ts` (interval, `/admin run`) and `adminAlert.ts` (admin DMs throttled to once a day per kind).
- `lifecycle.ts`: shutdown and the slash command runner (DM failure notice).
- `matcher/`: image embedder (transformers.js), cosine similarity, bounded image download.
- `notify/`: message building and DM sending.
- `commands/` (`/missing`, `/admin`, `/help`) and `interactions/` (buttons, modals, catalog import, reports).
- `database/`: Drizzle schema, migrations and one manager per table group.
- `utils/`: logger (`logError` for message plus stack), HTTP with User-Agent and timeout, async helpers, interaction error replies, Discord message length limits.

Docs: `docs/development.md`, `configuration.md`, `image-matching.md`, `deployment.md`.

## Invariants (Global Constraints)

- All tasks run through `./bin/mise run <task>`; a missing task is added to `.mise.toml`.
- Tooling and structure follow [IdleCodeRedeemer](https://github.com/BigMichi1/IdleCodeRedeemer), not its Idle Champions code.
- Every non-test source file in `src/` has a matching `*.test.ts` next to it (exemptions under Commands).
- Conventional Commits, scopes `bot`, `cards`, `database`, `shops`, `ebay`, `matcher`, `notify`, `commands`, `admin`, `ci`, `docs`, `docker`; every commit `git commit -s`, ending with the Co-Authored-By line; never `--no-verify`.
- Shell scripts and hooks are POSIX `sh` (no bash arrays under `#!/bin/sh`).
- Commands are imported statically in `bot.ts`.
- Timestamps are integer epoch milliseconds.
- Card ids are canonical strings: `"12"`, `"LE8"`, `"XXL1"` (no leading zeros, uppercase prefix).
- Never log `DISCORD_TOKEN`, `EBAY_CLIENT_SECRET` or eBay access tokens.
- Shop requests: User-Agent `minecraft-cards-bot/1.0 (+hourly stock check)`, 20 s timeout, 1500 ms between page requests of one shop.
- Env: see `docs/configuration.md` and `.env.example`.

## Review focus (each has a test)

- A shop fetch that throws (HTTP error, timeout) or raises `ShopLayoutError` (no card on any page, a page that is not a category page such as a Cloudflare or maintenance page, a later page without products, eBay searches all empty) is a shop error with a throttled admin alert, and must not mark that shop's stored listings unavailable.
- `/admin map` overrides survive the next scrape of the same listing.
- Sold out then back in stock re-notifies exactly once; staying in stock never re-notifies.
- A user with DMs closed does not stop other users' notifications, and their notification is not recorded as sent.
- `/missing set` with any unknown token changes nothing and names the bad tokens.

## Decisions to keep

- blue-ocean card ids come from the URL suffix (`...-tcc-12`), and only "On Fire" (series 3) titles are kept; series 1 and 2 listings share the category and would get wrong ids.
- The sammel-ente listing picture of the same card number is the image reference.
- Production runs `bun run src/bot/bot.ts`, not the compiled binary: the compiled binary cannot load the image model (`docs/image-matching.md`). `bun run build` remains but is not what the Docker image uses.
- `sharp` is bypassed: it hangs under Bun 1.4.4, so the embedder decodes and resizes with `Bun.Image`.
- Validate every URL (`validUrl` in `notify/messages.ts`) before it reaches a discord.js builder; one bad URL must not break a batch.
- An empty catalog import (no card ids recognised) changes nothing.
- Match statuses (`matcher/matchStatus.ts`, `docs/image-matching.md`): new listings start `pending`; `image_unavailable` is retried at most once a day; an admin-mapped listing is never reset by a rescrape.
- Only Discord error 50007 counts as closed DMs; other DM failures are retried without marking the user.
