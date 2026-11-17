# Minecraft Cards Bot — Design

Date: 2026-11-17
Status: draft, awaiting approval

## Intent

A Discord bot that tells a small group of friends when LEGO Minecraft trading cards
(Series 3, "On Fire": 228 base cards #1–#228 plus the limited editions #LE001–#LE0nn)
that they are still missing become buyable.
Each person keeps their own list of missing card numbers; the bot checks the shops once
an hour and DMs each person only about their own cards, with a direct link to the
listing. Buying stays manual.

Why: checking several shops by hand for a couple of hundred card numbers is tedious, and
the cheap single cards sell out quickly.

## Goals

- Per-user missing-card lists, entered as one comma-separated list of card numbers.
- Hourly check of:
  - shop-sammel-ente.de — `https://shop-sammel-ente.de/Minecraft/Serie-3/`
  - blue-ocean.de — `https://www.blue-ocean.de/produkte/lego/lego-minecraft/lego-minecraft-sticker-cards/`
  - eBay (Germany, `EBAY_DE`) via the official eBay Browse API
- DM notification with card number, name, shop, price, picture, link button to the
  listing, and a Kleinanzeigen search link.
- A "Wrong card" button on every notification that reports the problem to the bot admin.
- Local image comparison as a safety net for card identity (no cloud AI).

## Non-goals

- No buying, cart handling, or price tracking history.
- No scraping of Kleinanzeigen (no public API, its terms forbid scraping). Only a
  search link in the notification.
- No other card series in v1. The design should not make adding one hard, but it is
  not built.
- No puzzle packs (sammel-ente `PZL` products), starter packs or boosters; they are
  ignored by the parsers.
- No web UI.

## Anti-goals (would be a failure even if it technically works)

- Missing a real in-stock card because a check silently failed or a matcher dropped it.
  Failures must be logged and visible; an uncertain match is notified with a warning,
  never dropped.
- Spamming: the same listing must not be re-notified every hour while it stays in stock.
- Hammering shops: one fetch round per hour for all users together, polite request rate,
  identifiable but generic User-Agent.

## Constraints

- Follow the IdleCodeRedeemer project (`../IdleCodeRedeemer`) conventions: Bun runtime,
  TypeScript (typecheck-only via `bun check`), discord.js 14, `bun:sqlite` + Drizzle
  (`casing: 'snake_case'`, generated migrations), winston logging, vendored `./bin/mise`
  launcher with all tasks in `.mise.toml`, ESLint + Prettier + syncpack, husky hooks
  (gitleaks, eslint, commitlint Conventional Commits, DCO sign-off), `bun test` with
  `*.test.ts` next to every non-test source file, coverage gate, the same GitHub
  workflows (test, CodeQL, DCO, dependency review, secrets, docker, scorecards,
  release attestation), Dockerfile + docker-compose example, `docs/` folder linked
  from README. Copy the tooling and structure, not the Idle Champions code.
- Commands imported statically in `bot.ts` (dynamic scanning breaks compiled bundles).
- Config via environment variables, documented in `.env.example`.
- Never log secrets (Discord token, eBay credentials).

## Domain facts found during research

- **Card identity is the number printed on the card.** Names repeat (Alex is #1 and
  #14, Creeper #5 and #22, Ender Knight #2 and #107), so lists are numbers only.
- **Two number spaces:** base cards `1`–`228` and limited editions `LE1`–`LEnn`
  (sammel-ente titles `#LE008 Charged Creeper`, product code `MNC-03XX-LIM-0008`;
  at least LE001–LE022 seen). Internally a card id is a string: `"12"` or `"LE8"`.
  sammel-ente product codes also mark rarity (`BAS` basic, `RAR` rare); rarity is
  informational only, a rare #2 and "missing #2" are the same card.
- **Card catalog** (which card ids exist) lives in the database. The authoritative
  checklist is laststicker
  (`https://www.laststicker.com/cards/blue_ocean_lego_minecraft_on_fire/`), which is
  behind a Cloudflare bot check, so the bot never fetches it. Instead the admin copies
  its "Prüfliste für Nummern diese Sammlung" (a single comma-separated line:
  `1, 2, …, 228, LE1, …, LE22, XXL1`) and imports it with `/admin catalog import`
  (see Admin commands). The current list (228 base, LE1–LE22, XXL1) is committed as
  the starter catalog and loaded on first boot, so the bot works before any import.
- **Card names** are not in the checklist. They come from sammel-ente titles
  (`#012 Squid` → "Squid") and are refreshed on each run; a card without a known name
  is shown by number only.
- **XXL1** is in the official checklist, so it is a valid id (sammel-ente product code
  `MNC-03XX-XXL-0001`); listing parsers recognise `XXL` ids. Puzzle packs stay out.
- **sammel-ente** (Shopware 6 storefront, server-rendered HTML): product titles like
  `LEGO Minecraft Serie 3 | #012 Squid`; the `#NNN` is the true card number. Category
  has 11 pages (`?p=1..11`, 24 per page), also containing starter packs and boosters
  (no `#NNN`, ignored). Stock: "In den Warenkorb" = available, "Nicht verfügbar" =
  sold out. Product URL example:
  `https://shop-sammel-ente.de/LEGO-Minecraft-Serie-3-012-Squid/MNC-03XX-BAS-0012`.
- **blue-ocean** (Shopware 6 + Nuxt, server-rendered HTML): titles like
  `Nr. 9 Squid| UncommonLEGO Minecraft TCC "On Fire"`. **The title number is wrong.**
  The true card number is the trailing number of the product URL
  (`…-on-fire-2dd00088-12` → #12) and of the image file name (`LMC_TCG3_.P12.jpg`).
  Verified on 19/19 cards against sammel-ente names. Paging via `?p=N` (30 per page);
  the category also contains unrelated products (Harry Potter, magazines) — only
  products whose title contains `LEGO Minecraft TCC` are considered. Stock per product
  box: "Auf Lager" vs. "Nicht verfügbar".
- **eBay**: official Browse API (`item_summary/search`, OAuth client-credentials app
  token, marketplace `EBAY_DE`). Requires a free eBay developer account; app ID/secret
  are env vars. Listings are free-text titles from private sellers; many are bundles.

## Approaches considered (image safety net)

1. **Image embeddings in TypeScript via transformers.js (`@huggingface/transformers`)
   with a small CLIP/DINOv2-class model, on CPU.** — **Chosen.** Stays in the one
   Bun/TypeScript stack, ~0.1 s per image, small free model. Risk: may not work inside
   `bun build --compile`; fallback is shipping `bun run` inside the Docker image.
2. Same models in a Python sidecar service (open_clip / sentence-transformers). Most
   mature, but a second language, toolchain, test setup and container outside the
   IdleCodeRedeemer conventions. Rejected.
3. Local vision LLM via Ollama (Qwen2.5-VL, moondream) asked "same card / which
   number?". Multi-GB, slow on CPU, hard-to-detect wrong answers. Rejected.

Scraping approach: plain HTTP GET + HTML parsing of the public category pages for both
shops (no headless browser needed; both render product lists server-side). Shop-internal
JSON APIs were not used.

## Design

### Data flow (hourly, one round for all users)

1. Collect the union of all users' wanted card numbers. If empty, skip shops.
2. **Fetch shops** sequentially with a small delay between pages. Each shop adapter
   returns `Listing[]`: `{ shop, cardNumber | null, title, url, imageUrl, price,
available }`.
   - sammel-ente: card number from `#NNN` in the title.
   - blue-ocean: card number from URL suffix (cross-checked with image filename `P<n>`;
     if both present and disagree, the listing is marked unconfirmed).
   - eBay: a few searches per run (e.g. "lego minecraft on fire karte",
     "lego minecraft trading card"), marketplace `EBAY_DE`. v1 takes **all** listings:
     auctions and Buy-It-Now, any seller location, no price cap. Card ids are extracted
     from the title by pattern (`#12`, `Nr. 12`, `12/228`, `LE8`, …). A listing can
     carry **several** card ids (bundle): it is stored with all of them. Listings with
     no recognizable id are skipped and counted in the run result (the image matcher
     is a safety net, not a discovery tool, for eBay). Shown price is item price plus
     shipping when the API provides it, and the format (auction with end time / Buy It
     Now) is shown in the notification.
3. **Image check** (safety net): reference images are the sammel-ente card images
   (their numbering is reliable). For each listing with a card number that someone
   wants, compare its image embedding with the reference embedding of that card number.
   Outcome per listing: `confirmed` (similarity ≥ threshold), `unconfirmed` (below
   threshold or no reference yet), or `model unavailable`. eBay bundles and photos of
   several cards will usually be `unconfirmed`; that is shown, not acted on. Embeddings are cached by
   image URL. Reference embeddings are refreshed when the sammel-ente image URL changes.
4. **Diff against stored listing state**. A listing (keyed by shop + URL) triggers a
   notification for a user when it is available, its card is on that user's list, it is
   not on hold (see reports), and the user has not already been notified for this
   listing since it last became available. Sold-out → available again re-arms it.
5. **Notify** each affected user by DM, batched per run: one DM per user per run,
   split into several messages of at most 5 listings each (one embed and one button
   row per listing, within Discord's per-message limits). A bundle is one listing
   entry that names which of the user's missing cards it contains. This avoids a flood
   when someone first enters a long list. DM sends are paced to respect rate limits.
6. Persist listing state and run result (counts, errors per shop).

A failing shop (HTTP error, zero parsed cards on a page that should have them, layout
change) is logged at `error`, recorded in the run result, and reported to the admin by
DM at most once per shop per day. Other shops still run.

### Notification

Embed:

```
1️⃣ 🟢 Card #12 Squid is available
Shop: blue-ocean · Price: 0,99 € · Auf Lager
[listing image]
✅ picture matches reference (0.94)        ← or ⚠️ number unconfirmed (+ reference image)
[1️⃣ #12 · blue-ocean]  [Kleinanzeigen #12]  [❌ Wrong #12]
```

- Discord shows all button rows below all embeds of a message, so each embed title and its
  row start with the same position marker (1️⃣ to 5️⃣), and the buttons name their card
  (bundles: `Bundle · eBay`, `❌ Wrong bundle`). Labels stay within Discord's 80 characters.
- `#12 · blue-ocean`: link button to the listing URL.
- `Kleinanzeigen #12`: link button to a Kleinanzeigen search URL for
  `lego minecraft karte <number>` (exact query format left to builder).
- Card name comes from the sammel-ente reference catalog.

### Wrong-card report

- Button opens a modal: reason (wrong number / wrong series / other) and optional note.
- Bot DMs the admin (`BOT_ADMIN_ID`) with: reporter, card number, shop, listing URL,
  listing image, reference image, reason, note.
- The listing is put **on hold**: no further notifications for it to anyone until the
  admin acts.
- Admin commands (restricted to `BOT_ADMIN_ID`):
  - `/admin map <listing-url> <card-ids>` — override the card id(s) for a listing
    (a list, so bundles can be corrected too).
  - `/admin clear <listing-url>` — remove the hold (report was wrong).
  - `/admin catalog import <list>` — paste laststicker's comma-separated checklist
    (~1,100 characters, fits a slash-command text option; a leading header line such
    as "Prüfliste für Nummern diese Sammlung:" is ignored). The bot shows a preview
    (counts per type, added and removed ids) with [Save] / [Cancel] buttons. Removed
    ids that are on someone's list are warned about and left on those lists.
  - `/admin status` — last run time, per-shop counts and errors.
  - `/admin run` — trigger a check now.
- Reporter gets an ephemeral "thanks, admin notified" reply.

### User commands

- `/missing set <list>` — replace own list (e.g. `12, 45, 107`).
- `/missing add <list>` / `/missing remove <list>`.
- `/missing list` — show own list (compact, ranges allowed in output, e.g. `1-5, 12`).
- `/missing clear`.
- Input parsing: comma-separated, whitespace and case tolerant, `#12`, `012`, `LE8`,
  `#LE008`, `le 8`, `XXL1` accepted, ranges like `20-25` and `LE1-LE5` accepted; ids not in
  the catalog rejected with a clear message listing them; duplicates ignored.
- `/available` (optional, builder's call) — show currently available listings for own
  list.

Users must allow DMs from the server; if a DM fails, log it and tell the user on their
next command interaction.

### Storage (SQLite, Drizzle)

- `users` (discord id, created at)
- `wanted_cards` (user id, card id) — unique pair
- `cards` (card id, type base/LE/XXL, name, reference image URL, reference embedding,
  updated at) — the catalog; ids from the checklist import, names and reference images
  from sammel-ente
- `listings` (shop, url — unique; title, image URL, price, format, auction end,
  available, match status, similarity, on-hold flag, manual-override flag, first/last
  seen, last available-since)
- `listing_cards` (listing id, card id) — one row per card in the listing; bundles
  have several
- `notifications` (user id, listing id, available-since it was sent for) — prevents
  repeats
- `reports` (listing id, reporter, reason, note, created at, resolved at)
- `runs` (started, finished, per-shop counts/errors)

### Configuration (env)

`DISCORD_TOKEN`, `DISCORD_GUILD_ID`, `BOT_ADMIN_ID`, `DB_PATH`, `LOG_LEVEL`,
`CHECK_INTERVAL_MINUTES` (default 60), `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`
(eBay disabled with a startup warning when unset), `IMAGE_MATCH_THRESHOLD`
(default chosen by builder from measurements), `MODEL_CACHE_DIR`.

### Deployment

- Runs on the same personal root server as IdleCodeRedeemer, via Docker / docker
  compose, image `ghcr.io/bigmichi1/minecraft-cards`, SQLite in a mounted volume.
- Architecture assumed x86_64 (builder confirms with the user, e.g. `uname -m`, before
  the Docker work; arm64 would change the onnxruntime build).
- The image model is baked into the Docker image at build time, so the container is
  self-contained and starts without a download. Local dev downloads it once into
  `MODEL_CACHE_DIR`.
- Repository `bigmichi1/minecraft-cards` on GitHub, MIT licence (as IdleCodeRedeemer).

### Testing

- Shop parsers tested against saved HTML fixtures of real pages (committed under
  `src/test/fixtures/`), including blue-ocean's wrong-title case and non-card products.
- eBay client tested with recorded JSON responses; no live calls in tests.
- List parsing, diff/notification logic, hold/report flow tested against in-memory
  SQLite (as in IdleCodeRedeemer's test setup).
- Image matcher behind an interface so tests use a fake; one optional integration test
  runs the real model when the model is cached locally.

## Decided by the user

- Matching by card number; blue-ocean's title number is ignored in favor of the URL
  number.
- Multiple users with their own lists; per-user DMs.
- Local AI image comparison (option 1: transformers.js) as a safety net.
- Notification has a shop link and a way to report a wrong card to the bot admin.
- eBay in v1; Kleinanzeigen as a search link only.
- Hourly checks.
- Limited editions (LE) are tracked; the laststicker checklist defines which ids exist.
- The catalog is updated by an admin command that takes the pasted checklist.
- eBay v1: all listings (auctions + Buy It Now, any location, no price cap).
- eBay bundles are notified, naming which of the user's missing cards they contain.
- Runs on the same personal root server as IdleCodeRedeemer.

## Calls made by Claude (correct if wrong)

- Numbers-only lists (names are ambiguous).
- Notify once per listing per "became available" event, not every hour.
- Unconfirmed image matches are still notified, with a warning.
- Reported listings go on hold until the admin clears or remaps them.
- Admin identified by a single `BOT_ADMIN_ID` env var.
- sammel-ente images are the reference set.
- Failing shops reported to the admin at most once per shop per day.
- Notifications batched per run (≤ 5 listings per message) instead of one DM per card.
- Catalog stored in the database, starter catalog committed; card names from
  sammel-ente titles. XXL1 is tracked because it is in the official checklist.
- Model weights baked into the Docker image; x86_64 assumed until confirmed.
- Repo `bigmichi1/minecraft-cards`, image `ghcr.io/bigmichi1/minecraft-cards`, MIT.

## Left to the builder

- Exact embedding model (CLIP ViT-B/32 vs. DINOv2-small etc.) and the similarity
  threshold, chosen by measuring the 19 known blue-ocean ↔ sammel-ente pairs plus
  deliberately mismatched pairs.
- Whether transformers.js works in the compiled binary; if not, ship `bun run`.
- eBay search queries, category filter, and title-number patterns.
- Scheduler implementation (simple interval with no overlap, like IdleCodeRedeemer's
  single promise queue).
- Exact embed layout and wording.
