# Development

Everything runs through the vendored Mise launcher `./bin/mise`, which pins Bun, gitleaks,
ripgrep and jq into `.mise/`. Do not call `bun run`, `npm` or `npx` directly; a missing task
belongs in `.mise.toml`.

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
| `audit`                               | `bun audit`                                                 |
| `docker-build`                        | Build the production image                                  |

Extra arguments pass through: `./bin/mise run test src/bot/utils/async.test.ts`.

## Rules

- Every non-test source file in `src/` has a matching `*.test.ts` beside it.
- Conventional Commits with scopes `bot`, `cards`, `database`, `shops`, `ebay`, `matcher`,
  `notify`, `commands`, `admin`, `ci`, `docs`, `docker`; commit with `git commit -s`
  (see `DCO.md`). Hooks run gitleaks, eslint, commitlint and a DCO check; never `--no-verify`.
- Commands are imported statically in `bot.ts`.
- Shell scripts and hooks are POSIX `sh`.

## CI

`test.yml` runs typecheck, lint, format check and the coverage gate; further workflows cover
CodeQL, DCO, dependency review, secret scanning, Scorecard, the Docker build and a daily
`bun audit`. The workflows are copied from IdleCodeRedeemer with the Idle-specific jobs
(`deps:submit`, `audit:pr`) left out.
