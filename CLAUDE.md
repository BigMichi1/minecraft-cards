# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All tasks run through the vendored Mise launcher `./bin/mise` (it pins Bun, gitleaks, ripgrep and jq into `.mise/`, plus the maintainer's own `claude` and `python` tools, which the bot does not use but `mise install` also installs in CI and in the Docker builder stage). Do not call `bun run`, `npm`, or `npx` directly; if a task is missing, add it to `.mise.toml`.

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
- `shops/`: adapters for sammel-ente, blue-ocean, collect-it and eBay behind one `ShopAdapter` interface; `adapters.ts` builds the enabled list for `bot.ts`.
- `check/`: `runner.ts` (one round for all users), `scheduler.ts` (interval, `/admin run`) and `adminAlert.ts` (throttled admin alerts, at most once a day per key; the registration and model-load DMs are not throttled, they go once per start).
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

- A shop fetch that throws (HTTP error, timeout) or raises `ShopLayoutError` (no card on any page, a page that is not a category page such as a Cloudflare or maintenance page, a later page without products, eBay searches all empty, an eBay walk ending further below the total than its tolerance, or an eBay answer of the wrong shape; on collect-it also any incomplete walk or unreadable product box) is a shop error with a throttled admin alert, and must not mark that shop's stored listings unavailable.
- `/admin map` overrides survive the next scrape of the same listing.
- Sold out then back in stock re-notifies exactly once; staying in stock never re-notifies.
- A user with DMs closed does not stop other users' notifications, and their notification is not recorded as sent.
- `/missing set` with any unknown token changes nothing and names the bad tokens.

## Decisions to keep

- blue-ocean card ids come from the URL suffix (`…-tcc-on-fire-2dd00088-12`), and only "On Fire" (series 3) titles are kept; series 1 and 2 listings share the category and would get wrong ids.
- collect-it pages are walked by following each page's `<link rel="next">`, not by a page count: a page past the end redirects to page 1. collect-it hides sold-out cards, so a card vanishing from the category is how it sells out, and a partial read would mark real listings sold out. So a page whose canonical link is missing, unreadable, or names another page than the one linked is a shop error (`ShopLayoutError`), as is reaching the page cap or any unreadable product box or title. The walk must also read exactly the article total that page 1's pagination text names (`Du hast 30 von 235 Artikeln gesehen`), and every page that links a next page must hold a full page of 30 products; otherwise it is a `ShopLayoutError` too (this catches a dropped `rel="next"` and cards shifting between pages). The run is retried next hour, and stored listings are left untouched. Shop-controlled values in those errors are clipped to 200 characters, and admin alerts to Discord's 2000.
- The sammel-ente listing picture of the same card number is the image reference.
- Production runs `bun run src/bot/bot.ts`, not the compiled binary: the compiled binary cannot load the image model (`docs/image-matching.md`). `bun run build` remains but is not what the Docker image uses.
- `sharp` is bypassed: it hangs under Bun 1.4.4, so the embedder decodes and resizes with `Bun.Image`.
- Validate every URL (`validUrl` in `notify/messages.ts`) before it reaches a discord.js builder; one bad URL must not break a batch.
- An empty catalog import (no card ids recognised) changes nothing.
- Match statuses (`matcher/matchStatus.ts`, `docs/image-matching.md`): new single-card listings of shops other than sammel-ente start `pending`; `image_unavailable` is retried at most once a day; an admin-mapped listing is never reset by a rescrape, nor compared or identified again.
- Picture identification (`matcher/identify.ts`, rules 1-5 in `docs/image-matching.md`): each picture is also compared with every reference. Decided means the best match is at least `IMAGE_MATCH_THRESHOLD` and leads the second-best by `DECISION_GAP` (0.02). A decided other card, while the title card's own reference stays below the threshold, is a `mismatch`: never notified, one throttled admin note per listing, never re-mapped automatically. Puzzle cards (`cards.puzzle`, from "Puzzlekarte" in the sammel-ente name, never lifted) and twins (references at least `TWIN_SIMILARITY` alike, e.g. #59 and XXL1) are never taken from the picture alone. The picture decides another card than the title's (rules 2 and 4) only against the complete reference set (every catalog card loaded and usable; a narrower per-kind scope does not hold, see the docs); a listing compared while a reference failed to load gets `image_unavailable`/`model_unavailable`, never a final `unconfirmed` or `mismatch`. Mismatch notes are durable (`mismatch_noted_at`) and throttled per listing and picture card; a card is a puzzle card when its name says "Puzzlekarte" or ever did (`cards.puzzle_seen`, sticky). A placeholder reference (file name with `_leer.`, or one picture sammel-ente shows for several cards, such as LE10 and LE11 on 2026-11-18) is no reference: `no_reference`, never identified, never shown as a thumbnail.
- eBay titles naming no card but passing every single-card check and carrying no count word and no number but the series and a year (`isPictureCandidate`) are passed on without ids (`idSource: 'picture'`); a decided picture gives them their card (`confirmed`, "number from the picture"), an undecided one leaves them stored without ids, so never notified.
- One-click confirm (`interactions/right.ts`, `interactions/adminActions.ts`, `docs/image-matching.md`): the "✅ Right" button sits only on single-card `unconfirmed` alerts and DMs the admin at most once a day per listing, without hold or report. The admin's Confirm (`admin-confirm:<listing>:<cards>`) is `/admin map` with the current cards but keeps `availableSince`, so it never re-notifies, and is refused when the cards or the picture (fingerprint in the customId) changed since the DM, or the listing is `mismatch` or `pending`; Dismiss is `/admin clear`. Only `BOT_ADMIN_ID` can press them.
- Only Discord error 50007 counts as closed DMs; other DM failures are retried without marking the user.
- Alert layout (`notify/messages.ts`): a user with at most `SINGLE_MESSAGE_LIMIT` (5) pending items in a run gets one DM per listing, its buttons right under it; more are batched 5 per message with position markers, at most 25 per run. Each message is recorded only once sent.
- Alert pictures (listing image and reference thumbnail) are downloaded by the bot with the matcher's bounded `downloadImage` and attached to the DM (`notify/pictures.ts`, `attachment://picture-<n>` / `reference-<n>`): Discord's proxy shows no collect-it pictures. A picture that cannot be attached keeps its URL, and a message Discord rejects as a bad payload (400/413, not 50007) is resent once without pictures; a picture never costs the alert. Fallbacks raise the throttled `notify-pictures` alert (rule in `docs/image-matching.md`).
- eBay card ids come only from titles naming series 3 (`Serie 3`, `On Fire`) and no other series; none from pick lists (`aussuchen`, `Auswahl`, `choose`), number ranges (`1 - 228`) or listings with variations. A title without a series word gives no ids (series 1 and 2 used the same title forms), unless the catalog name of each number it reads stands right beside that number and, those numbers and names taken out, only the allowed words `NAME_TITLE_WORDS` (brand, card words, `Charakterkarte`, rarity, condition, `Nr`/`No`, `2026`) and punctuation are left (`nameMatchedCardIds`: `Karte 131 - Ghast` is #131; `Karte 104 - Ghast` is nothing, as series 3 #104 is not Ghast; `Comic Karte 3 - Steve` and `Gold Ghast Karte 131` are nothing); titles with a pick list, range, variation or `COUNT_WORDS` word never qualify; the allow-list is extended only by a reviewed change to `NAME_TITLE_WORDS` and its equality test. The new title forms are allow-lists: `N - Name - <card type>` needs a known card type and no product word as name, `NAME N Karte` a word from `CARD_NAME_WORDS`. Excluded titles count as `skippedExcluded`, apart from `skippedNoId`. Searches are read by `offset`, a multiple of the page size (eBay answers 400 otherwise; pages may be short, so never the count read), at most 5 pages per query; a cut search alerts the admin (`shop-truncated:ebay`), and a walk ending more than max(5, 2 % of the total) short of eBay's estimated `total` (and an empty first page with a total above 0) is a `ShopLayoutError`; a smaller gap is accepted with a warning and no alert. A number followed by a word of the one shared list `COUNT_WORDS` (counts, units, prices, products, seller slogans, plus `€` and `-fach`) is never a card id, in every number form; extend that list, not a form's own guard (`docs/shops.md`).
