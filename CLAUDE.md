# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All tasks run through the vendored Mise launcher `./bin/mise` (it pins Bun/gitleaks/rg into `.mise/`). Do not call `bun run`, `npm`, or `npx` directly; if a task is missing, add it to `.mise.toml`.

```bash
./bin/mise run install       # bun install
./bin/mise run dev           # run bot from source (bun run --bun src/bot/bot.ts)
./bin/mise run typecheck     # bun check -p tsconfig.bot.json
./bin/mise run test          # bun test
./bin/mise run test:coverage # lcov -> coverage/lcov.info
./bin/mise run lint          # eslint src
./bin/mise run lint:fix
./bin/mise run format        # syncpack + prettier
./bin/mise run format:check
./bin/mise run build         # compiled binary -> dist-bundle/bot
./bin/mise run gitleaks      # secret scan
```

Extra args pass through: `./bin/mise run test src/bot/utils/async.test.ts`, `./bin/mise run test -t "name"`.

Database migrations are generated: edit `src/bot/database/schema/*.ts`, then `./bin/mise run db:generate`.

Commits: Conventional Commits, signed off (`git commit -s`). Hooks run gitleaks, eslint, commitlint and a DCO check; never use `--no-verify`. Every non-test source file needs a matching `*.test.ts`.

## Architecture

Filled in as the implementation tasks land. See `docs/` for the design and plan.
