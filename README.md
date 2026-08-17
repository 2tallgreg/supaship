# Supaship

Supaship is a deterministic Supabase shipping gate for [OpenCode](https://opencode.ai/). It scans changed migrations and declarative schema files, runs local verification, records evidence against a content fingerprint, and stops an agent from shipping a changed fingerprint without fixing or explicitly approving it.

The product is **Supaship**. The npm package is **`opencode-supaship`** because the unscoped `supaship` package name is already occupied.

## What it checks

- RLS is enabled for new tables in exposed schemas.
- Every new exposed table makes an explicit `GRANT` or `REVOKE` decision.
- UPDATE policies include `WITH CHECK`; write policies are not unconditionally open.
- Policies do not authorize with deprecated `auth.role()` or user-editable metadata.
- `auth.uid()` and `auth.jwt()` use the RLS init-plan pattern, `(select auth.uid())`.
- Exposed views use `security_invoker = true`; exposed materialized views make an explicit access decision.
- `SECURITY DEFINER` functions stay out of exposed schemas, lock `search_path`, check caller identity, and revoke default execution.
- Migrations do not disable RLS, broadly grant privileges, modify Supabase-managed schema objects, delete old migrations, or perform destructive DDL without approval.
- RLS changes have pgTAP tests.
- The local database has no schema changes missing from migrations, it rebuilds, database lint passes, Supabase's own security advisors pass, pgTAP passes, and generated TypeScript types are current.

Supaship follows Supabase's current separation between [Data API grants and RLS](https://supabase.com/docs/guides/api/securing-your-api), its [RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security), and its [local migration workflow](https://supabase.com/docs/guides/local-development/cli-workflows).

## Install

```bash
opencode plugin opencode-supaship
```

Or add it to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-supaship"]
}
```

Supaship works without a config file. To create one:

```bash
supaship init
```

Before verification, start the local Supabase stack:

```bash
supabase start
```

The default verification rebuilds the **local** database with `supabase db reset`. OpenCode asks for permission before running the verification plan. None of the default Supaship checks writes to a linked or production database.

## OpenCode tools

| Tool | Purpose |
| --- | --- |
| `supaship_status` | Static scan plus existing evidence; never writes or runs database commands. |
| `supaship_doctor` | Reports the CLI version, local stack state, linked project, and available subcommands, with a fix for each problem. |
| `supaship_verify` | Runs the approved local verification plan and records fingerprinted results. |
| `supaship_sync_types` | Regenerates the configured TypeScript database types after permission. |
| `supaship_approve` | Requests a reasoned, time-limited human override for exactly one fingerprint. |

Typical flow:

1. Ask OpenCode to run `supaship_status`.
2. Fix static findings.
3. Run `supaship_verify`.
4. If generated types are stale, run `supaship_sync_types`, then verify again.
5. Push, create the PR, or merge. Supaship allows the guarded command only while evidence matches the current fingerprint.

If a Supabase command fails, `supaship_doctor` answers why before you retry. It runs a fixed read-only allowlist — `supabase --version`, `supabase status`, and `--help` probes — so it needs no permission prompt and never touches a database.

### Guarded commands

By default Supaship intercepts these agent-issued commands:

| Guarded | Why |
| --- | --- |
| `supabase db push` | Applies migrations to the linked project. |
| `supabase db reset --linked` / `--db-url` | Rebuilds a *remote* database from migrations. |
| `supabase db query --linked` / `--db-url` | Runs arbitrary SQL against a remote database. |
| `supabase migration up/down/squash` with `--linked` or `--db-url` | Changes remote migration state. |
| `supabase migration repair` | Rewrites remote migration history. |
| `supabase functions deploy` / `delete` | Changes deployed edge functions. |
| `supabase secrets set` / `unset`, `supabase config push` | Changes remote project configuration. |
| `supabase branches create` / `delete` / `update` | Changes preview branches. |
| `git push`, `gh pr create`, `gh pr merge` | Ships the change. |

The local loop — `supabase db reset`, `db diff`, `db lint`, `db advisors`, `test db`, `migration up`, `gen types` — is never guarded. Read-only remote commands (`db lint --linked`, `db advisors --linked`, `migration list --linked`) are not guarded either.

`--dry-run` commands are allowed, and every command in a compound shell line is checked separately, so `git push --dry-run && git push` is still blocked. Commands typed directly in a separate shell are outside OpenCode's plugin hooks and cannot be intercepted.

## CLI

The same engine can run outside OpenCode:

```bash
supaship status
supaship status --all
supaship doctor
supaship verify
supaship verify --json
```

`status` and `verify` exit non-zero when shipping is blocked, and `doctor` exits non-zero when the Supabase CLI or local stack is unusable, so all three can be used in CI.

## Configuration

Supaship loads `supaship.config.json` or `.supaship.json` from the project root. Arrays replace the defaults; nested objects merge with them.

```json
{
  "$schema": "./node_modules/opencode-supaship/schema.json",
  "baseRef": "origin/main",
  "sqlDirectories": ["supabase/migrations", "supabase/schemas"],
  "testDirectories": ["supabase/tests"],
  "exposedSchemas": ["public"],
  "preflight": true,
  "generatedTypes": {
    "path": "src/types/database.types.ts",
    "command": "{supabase} gen types typescript --local",
    "required": true
  },
  "guard": {
    "mode": "block",
    "requireFreshEvidence": true,
    "blockOnWarnings": false,
    "approvalMinutes": 30
  }
}
```

`generatedTypes` may be `false`, `"auto"`, or an object. Auto-detection recognizes common `database.types.ts` locations. In any command, `{supabase}` resolves to the project's local binary when present and otherwise to `supabase` on `PATH`, and `{schemas}` resolves to the comma-separated `exposedSchemas` list.

### Verification checks

The default plan is:

```json
[
  {
    "id": "db-drift",
    "name": "Local database matches committed migrations",
    "command": "{supabase} db diff --local --schema {schemas}",
    "required": false,
    "when": "supabase-changed",
    "expect": { "stdoutMustNotMatch": "^\\s*(?:create|alter|drop|revoke|grant)\\b" }
  },
  {
    "id": "db-reset",
    "name": "Rebuild the local database from migrations",
    "command": "{supabase} db reset",
    "required": true,
    "when": "supabase-changed"
  },
  {
    "id": "db-lint",
    "name": "Lint database functions and schema",
    "command": "{supabase} db lint --local --level error --fail-on error",
    "required": true,
    "when": "supabase-changed"
  },
  {
    "id": "db-advisors",
    "name": "Supabase security advisors on the local database",
    "command": "{supabase} db advisors --local --type security --fail-on error",
    "required": true,
    "when": "supabase-changed"
  },
  {
    "id": "db-tests",
    "name": "Run pgTAP database tests",
    "command": "{supabase} test db",
    "required": true,
    "when": "database-tests-present"
  }
]
```

`db-drift` runs first on purpose: `supabase db reset` recreates the local database from migrations, so a schema change made in Studio or `psql` and never written to a migration is gone after it. It costs a shadow-database container, so it is the slowest default check and the one to drop first if verification time matters more than that protection. `db-lint` uses `--fail-on error` because `--level` only controls what is printed — without it, lint findings do not fail the check. `db-advisors` re-checks against the rebuilt database what static analysis can only infer from SQL text: missing RLS, exposed `auth.users`, definer views, unindexed foreign keys.

Application tests, typechecks, or builds can be added the same way. Supported `when` values are `always`, `supabase-changed`, and `database-tests-present`.

Checks that read a remote project (`{supabase} migration list --linked` before a push, `{supabase} db advisors --linked`) are allowed but not enabled by default. Checks that **write** to a linked or remote database are rejected when the config loads — verification runs without the guard in front of it, so a `db push` check would ship straight to production. Set `"allowRemoteWrites": true` on a check to accept that risk deliberately.

#### Output expectations

Several Supabase CLI commands report by output rather than exit code — `db diff` prints a schema delta and still exits `0`. A check can assert on what the command wrote:

| Field | Meaning |
| --- | --- |
| `expect.stdoutMustBeEmpty` | Fail if standard output has any content. |
| `expect.stdoutMustNotMatch` | Fail if standard output matches this regex (case-insensitive, multiline). |
| `expect.outputMustNotMatch` | Same, against standard output and standard error combined. |
| `expect.message` | The message reported when the expectation fails. |

### CLI environment

With `preflight` enabled (the default), Supaship reads the CLI version and local stack state once before running any Supabase check. A stopped Docker daemon then costs one immediate, explained failure instead of a stalled `db reset` per check. Preflight is skipped entirely when no applicable check invokes the Supabase CLI.

When a check fails, Supaship maps known CLI output to the next command to run — install the CLI, start Docker, run `supabase start`, run `supabase link`, upgrade the CLI, or reconcile migration history with `supabase migration repair`.

A check whose subcommand or flag the installed CLI does not have (`unknown command "advisors"`) is recorded as unsupported rather than failed: it does not block, because no repository change can fix it, and it is named in the report so the gap is visible.

### Rules

Each rule accepts `"error"`, `"warning"`, `"info"`, or `"off"`:

| Rule | Default | Meaning |
| --- | --- | --- |
| `SUPA001` | error | New exposed table lacks RLS. |
| `SUPA002` | error | New exposed table lacks an explicit Data API access decision. |
| `SUPA003` | error | RLS is disabled. |
| `SUPA004` | error | UPDATE/ALL policy lacks explicit `WITH CHECK`. |
| `SUPA005` | error | A write policy is unconditionally open. |
| `SUPA006` | warning | A policy uses `auth.role()`. |
| `SUPA007` | error | Authorization uses user-editable metadata. |
| `SUPA008` | error | An exposed view lacks `security_invoker`, or an exposed materialized view lacks an access decision. |
| `SUPA009` | error | A `SECURITY DEFINER` function is exposed. |
| `SUPA010` | error | A definer function has an unsafe `search_path`. |
| `SUPA011` | warning | Definer execution is not revoked from `PUBLIC`. |
| `SUPA012` | warning | A definer helper has no caller identity check. |
| `SUPA013` | warning | An auth function is evaluated per row in RLS. |
| `SUPA014` | error | Destructive DDL or migration deletion. |
| `SUPA015` | error | DDL targets a Supabase-managed schema object. |
| `SUPA016` | error | `ALL` privileges go to a public API role. |
| `SUPA017` | warning | RLS changed without database tests. |

Example override:

```json
{
  "rules": {
    "SUPA002": "error",
    "SUPA012": "info"
  }
}
```

## Evidence and approvals

Evidence is stored locally in `.opencode/supaship/state.json`; add `.opencode/supaship/` to `.gitignore`. The fingerprint includes relevant SQL, tests, Supabase config, generated types, rule settings, and verification commands.

An approval records a reason, fingerprint, approval time, and expiry. Any relevant edit produces a new fingerprint and invalidates both evidence and approval. Supaship never silently approves future changes.

## Scope and limitations

Supaship is intentionally conservative static analysis. SQL is parsed with a quote- and dollar-body-aware scanner, but it does not connect to production or attempt to prove policy semantics. A clean report is evidence that known mechanical requirements were met—not a replacement for threat modeling, realistic RLS tests, database advisors, backups, or a human migration review.

## Development

```bash
npm install
npm test
npm run pack:check
```

Requires Node.js 20+ for development. OpenCode loads the compiled ESM plugin with Bun.
