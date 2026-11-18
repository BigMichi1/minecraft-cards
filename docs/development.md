# Development

Everything runs through the vendored Mise launcher `./bin/mise`, which pins Bun, gitleaks,
ripgrep and jq into `.mise/`. `.mise.toml` also pins `claude` (Claude Code) and `python`: the
maintainer's own toolchain, not used by the bot or its tests. `mise install` still installs
them everywhere it runs, in CI (`test.yml`, `audit.yml`) and in the Docker builder stage; the
production image does not carry them. Do not call `bun run`, `npm` or `npx` directly; a missing
task belongs in `.mise.toml`.

## Setup

```sh
./bin/mise install            # pinned toolchain
./bin/mise run install        # dependencies (bun install)
cp .env.example .env          # then set DISCORD_TOKEN and BOT_ADMIN_ID
./bin/mise run model:download # once, ~85 MB image model into ./models
./bin/mise run dev
```

## Tasks

| Task                                  | What it does                                                |
| ------------------------------------- | ----------------------------------------------------------- |
| `dev`                                 | Run the bot from source                                     |
| `typecheck` / `lint` / `format:check` | Static checks (CI runs all three)                           |
| `test` / `test:coverage`              | Tests / tests with `coverage/lcov.info`                     |
| `format` / `lint:fix`                 | Apply Prettier + syncpack / ESLint fixes                    |
| `db:generate`                         | Generate a Drizzle migration after editing `schema/*.ts`    |
| `model:download`                      | Fetch `IMAGE_MODEL` into `MODEL_CACHE_DIR`                  |
| `measure:threshold`                   | Measure similarity of true/false card pairs (needs network) |
| `gitleaks`                            | Secret scan                                                 |
| `audit`                               | `bun audit` (also shows the known, ignored advisory)        |
| `audit:ci`                            | `bun audit` minus `vars.audit_ignores` (what CI runs)       |
| `docker-build`                        | Build the production image                                  |

Extra arguments pass through: `./bin/mise run test src/bot/utils/async.test.ts`.

Migrations of a feature branch may still be regenerated before it merges (a new file name and
`when`), so a local database that ran a branch's unmerged migrations can refuse the merged
ones. Delete such a dev database (`DB_PATH`, `./data/cards.db` by default) and let the bot
create it again. Production deploys only from `main`, whose migrations never change.

## Rules

- Every non-test source file in `src/` has a matching `*.test.ts` beside it. Exempt:
  `src/bot/bot.ts` (entrypoint wiring; its logic is in tested modules such as `lifecycle.ts`),
  `src/bot/database/schema/*.ts` (covered by the smoke test `src/bot/database/db.test.ts`),
  and the test helpers in `src/test/`.
- Tests build card ids with `cid()` / `ids()` from `src/test/cardIds.ts`: `CardId` is a
  branded string.
- Conventional Commits with scopes `bot`, `cards`, `database`, `shops`, `ebay`, `matcher`,
  `notify`, `commands`, `admin`, `ci`, `docs`, `docker`; commit with `git commit -s`
  (see `DCO.md`). Hooks run gitleaks, eslint (check only; fix with `lint:fix` and stage the
  result), commitlint and a DCO check; never `--no-verify`.
- Commands are imported statically in `bot.ts`.
- Shell scripts and hooks are POSIX `sh`.

## CI

`test.yml` runs typecheck, lint, format check and the coverage gate; further workflows cover
CodeQL, DCO, dependency review, secret scanning, Scorecard, the Docker build and a dependency
audit (`audit:ci`) on every push to main and daily. The workflows follow [IdleCodeRedeemer](https://github.com/BigMichi1/IdleCodeRedeemer)'s,
without its Idle-specific jobs.
