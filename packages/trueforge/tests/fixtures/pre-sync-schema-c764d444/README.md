# Fixture: pre-sync migration chain (commit c764d444)

`preSyncSqliteMigrations.ts` and `preSyncPostgresMigrations.ts` are frozen,
generated copies of `packages/trueforge/src/db/sqlite/migrations` and
`packages/trueforge/src/db/postgres/migrations` as they existed at commit
`c764d444` — main's tip immediately before the upstream sync merged in
`96e0fb1f` (`sync/upstream-2026-09-13`). That sync added 31
migrations dated `20260821` through `20260911` to each engine's chain and
introduced `allowUnorderedMigrations`-based interleaving with the fork's own
migrations.

Each file exports a `Record<string, Migration>` (Kysely's `Migration` type:
`{ up, down }`), one entry per migration file at that commit, consolidated
into a single tracked file per engine instead of one file per migration
(the original per-file snapshot pushed this repo's changed-file count past
what `scripts/pre-push.mjs` can pass to `prettier --check` on Windows). Each
migration's `up`/`down` are otherwise byte-for-byte what shipped at
c764d444; only the exported function names were made unique
(`up_m<migration name>` / `down_m<migration name>`) and the two files these
migrations imported from outside their own migrations folder
(`personas/persona.ts`'s `personaNameKeys` and its two direct dependencies,
and `postgres/migrationTransaction.ts`'s `withMigrationTransaction`) were
inlined.

These fixtures exist so the upgrade tests in
`tests/unit/db/preSyncUpgrade.test.ts` and
`tests/db/postgres/preSyncUpgrade.test.ts` can build a database exactly the
shape a real pre-sync deployment (e.g. the PC standalone instance) has, then
run the _current_ migrator against it and assert the upgrade still succeeds.

## Regenerating

Do not hand-edit these files. Regenerate both from the real migration files
at c764d444:

```
git archive c764d444 \
  packages/trueforge/src/db/sqlite/migrations \
  packages/trueforge/src/db/postgres/migrations \
  packages/trueforge/src/db/postgres/migrationTransaction.ts \
  packages/trueforge/src/personas/persona.ts \
  | tar -x -C <tmp>/packages/trueforge/src/../..
```

then run a small script against `<tmp>/packages/trueforge/src` that, per
engine: for each migration file, strips its `kysely` import, renames its
`export async function up(` / `down(` to unique `up_m<name>` /
`down_m<name>` functions, and appends `'<name>': { up: up_m<name>, down:
down_m<name> }` entries to a `Record<string, Migration>` export; then
prepends one shared `import { sql, type Kysely } from 'kysely'; import type
{ Migration } from 'kysely/migration';` and the inlined `personaNameKeys` /
`withMigrationTransaction` helpers those migrations need. If a future test
needs a different pre-sync snapshot, add a new fixture directory named for
that commit instead of changing this one.
