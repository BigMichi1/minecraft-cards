# Collections PR 5: docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the rollout. A maintainer can add a collection from `docs/collections.md` alone, and no doc still describes the one-collection bot.

**Architecture:** This PR changes docs only, no code. Most per-PR doc updates already landed with #34–#45. A survey on 2026-11-25 found what is left:

- `docs/collections.md` does not exist (spec "Collection registry": "Adding a collection (documented in `docs/collections.md`)").
- `docs/development.md:56-65` says a shop adapter is bound to one collection, with only eBay shared. blue-ocean's walk is shared too (PR 3c), and shops are listed per collection.
- `docs/image-matching.md:14` says the fallback shop is "sammel-ente for every series". Turbo Attax has none.
- `CLAUDE.md:47`: the "Docs:" line lists neither `shops.md` nor the new `collections.md`.
- `docs/configuration.md` has no collection setting to document, since collections live in code (spec "Non-goals"). One sentence says so.

**Tech Stack:** Markdown, prettier (`format:check`).

**Spec:** `docs/superpowers/specs/2026-11-19-multi-collection-design.md`. Read these sections:

- "Collection registry".
- "Rollout in steps", item 5.
- "Notes from PR 3a", "Notes from PR 3b", "Notes from PR 3c" and "Notes from PR 4" (what a definition holds now).

## Global Constraints

- All tasks run through `./bin/mise run <task>`.
- Commits:
  - Conventional Commits (scope `docs`), `git commit -s`.
  - Every message ends with the Co-Authored-By and Claude-Session lines.
  - Never use `--no-verify`.
- Docs state facts the code has. Every field, file and command named must exist (check with `grep`).

## Review Focus

1. **Every step of `docs/collections.md` matches the code.** A reader who follows it gets a collection that passes the start checks (`checkSettings`, `checkIdRule`, `checkDistinctBlueOcean` in `shops/adapters.ts`) and the registry tests (`collections/index.test.ts`). Check: the reviewer walks the doc against `collections/ids.ts`, `collections/index.ts`, `cards/cardId.ts` and `shops/adapters.ts`.
2. **Which shops need code and which only settings is stated right:**
   - sammel-ente and blue-ocean read Minecraft ids only (refused at start otherwise);
   - eBay's `idForms` is one of two readers;
   - collect-it and euro-soccer-cards take any rule.

   A new id rule with eBay needs a reader (`ebay.ts` `readIdsIn`, `adapters.ts` `FORM_RULES`).

3. **What happens after deploy is stated:**
   - the slash command choices are registered at start (`bot.ts` `commands.set`);
   - the catalog arrives with the first check (or `/admin catalog sync`);
   - cards laststicker lacks are added with `/admin catalog add`.

---

### Task 1: `docs/collections.md` and the stale doc lines

**Files:**

- Create: `docs/collections.md`.
- Modify:
  - `docs/development.md:56-65`;
  - `docs/image-matching.md:14`;
  - `docs/configuration.md` (one sentence);
  - `CLAUDE.md:47` (Docs line);
  - `README.md` (link to `docs/collections.md` where the collections are listed).
- Modify the spec: one line under "Rollout in steps", item 5: done in PR 5.

**Content of `docs/collections.md`:**

1. **What a collection is.** One definition in code (`src/bot/collections/<name>.ts`) with:
   - its own catalog;
   - its shops;
   - its wanted lists.

   Ids are never renamed or removed.

2. **Adding one, step by step:**
   1. Add the id to `COLLECTION_IDS` (`collections/ids.ts`, a slug).
   2. Write the definition file with these fields (as in `CollectionDefinition`):
      - `id`, `name`;
      - `cardIds`: an existing rule from `cards/cardId.ts`, or a new `CardIdRule` (uppercase prefixes, two-letter code families);
      - `kleinanzeigen` search words;
      - `laststicker` `{ set, scans?, numberAliases? }`;
      - `referenceFallbackShop`, `knownTwins`, `starterChecklist` (optional);
      - `shops`.
   3. Register it in `DEFINITIONS` (`collections/index.ts`); a missing entry is a compile error.
   4. Fill `shops` with one entry per shop that sells it (the table below).
   5. Add tests and fixtures:
      - the definition's `<name>.test.ts`;
      - a laststicker set page fixture;
      - one fixture per shop page;
      - for eBay, a reviewed title fixture.

      Extend `collections/index.test.ts`, which lists the registry and the slash choices.

   6. Run `typecheck`, `test` and `lint`. The start checks run in `adapters.test.ts` through `createShopAdapters`.
   7. After deploy:
      - the choices appear at the next start;
      - the catalog syncs with the next check or `/admin catalog sync collection:<id>`;
      - missing cards come in with `/admin catalog add`.
3. **Table of shops, with their settings and limits:**

   | Shop              | Settings                                                          | Limits                                                         |
   | ----------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
   | sammel-ente       | `category`, `series: 'Serie N'`                                   | Minecraft rule only                                            |
   | collect-it        | `category`, `series` (`Serie N` or a year)                        | any rule                                                       |
   | blue-ocean        | `productCode`, `categoryPath?`, `picture?`, `title?`, `excludes?` | Minecraft rule only; one shared walk, distinct codes and paths |
   | euro-soccer-cards | `category` ending with `/`, `slugSuffix`                          | any rule                                                       |
   | eBay              | `queries`, `series` marker, `idForms`, `excludes?`, `maxPages?`   | `idForms` must fit the rule                                    |

   Each row points to its section in `docs/shops.md`.

4. **A new id rule or shop needs code:**
   - a new `CardIdRule` with eBay titles needs an `idForms` reader;
   - a new shop needs an adapter, a `SHOP_IDS` entry, a host in `SHOP_HOSTS` and `IMAGE_HOSTS`, and the labels in `notify/messages.ts` and `commands/stockPage.ts`.
5. **The worked example** is Turbo Attax 2026 (PR 4 and 4b), with links to its definition and tests.

- [ ] **Step 1: Write `docs/collections.md` and fix the stale lines.**
- [ ] **Step 2: Verify every name the doc uses exists.**
  - Run: `rg -n` for each field and function named (`COLLECTION_IDS`, `DEFINITIONS`, `CardIdRule`, `checkIdRule`, `FORM_RULES`, `SHOP_HOSTS`, `IMAGE_HOSTS`, `readIdsIn`).
  - Expected: each is found in `src/`.
- [ ] **Step 3: Run checks.**
  - Run: `./bin/mise run format:check`
  - Expected: `All matched files use Prettier code style!`
- [ ] **Step 4: Commit** `docs: how to add a collection, and the last one-collection doc lines`
