# Supaship

Supaship is a deterministic Supabase shipping gate for [OpenCode](https://opencode.ai/). It scans changed migrations and declarative schema files, runs local verification, records evidence against a content fingerprint, and stops an agent from shipping a changed fingerprint without fixing or explicitly approving it.

The product is **Supaship**. The npm package is **`opencode-supaship`** because the unscoped `supaship` package name is already occupied.

## What it checks

- RLS is enabled for new tables in exposed schemas.
- Every new exposed table makes an explicit `GRANT` or `REVOKE` decision.
- UPDATE policies include `WITH CHECK`; write policies are not unconditionally open.
- Policies do not authorize with deprecated `auth.role()` or user-editable metadata.
- `auth.uid()` and `auth.jwt()` use the RLS init-plan pattern, `(select auth.uid())`.
- Exposed views use `security_invoker = true`.
- `SECURITY DEFINER` functions stay out of exposed schemas, lock `search_path`, check caller identity, and revoke default execution.
- Migrations do not disable RLS, broadly grant privileges, modify Supabase-managed schema objects, delete old migrations, or perform destructive DDL without approval.
- RLS changes have pgTAP tests.
- The local database rebuilds, database lint passes, pgTAP passes, and generated TypeScript types are current.

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
| `supaship_verify` | Runs the approved local verification plan and records fingerprinted results. |
| `supaship_sync_types` | Regenerates the configured TypeScript database types after permission. |
| `supaship_approve` | Requests a reasoned, time-limited human override for exactly one fingerprint. |

Typical flow:

1. Ask OpenCode to run `supaship_status`.
2. Fix static findings.
3. Run `supaship_verify`.
4. If generated types are stale, run `supaship_sync_types`, then verify again.
5. Push, create the PR, or merge. Supaship allows the guarded command only while evidence matches the current fingerprint.

By default Supaship intercepts agent-issued `supabase db push`, `git push`, `gh pr create`, and `gh pr merge`. `--dry-run` commands are allowed. Commands typed directly in a separate shell are outside OpenCode's plugin hooks and cannot be intercepted.

## CLI

The same engine can run outside OpenCode:

```bash
supaship status
supaship status --all
supaship verify
supaship verify --json
```

`status` and `verify` exit non-zero when shipping is blocked, so they can be used in CI.

## Configuration

Supaship loads `supaship.config.json` or `.supaship.json` from the project root. Arrays replace the defaults; nested objects merge with them.

```json
{
  "$schema": "./node_modules/opencode-supaship/schema.json",
  "baseRef": "origin/main",
  "sqlDirectories": ["supabase/migrations", "supabase/schemas"],
  "testDirectories": ["supabase/tests"],
  "exposedSchemas": ["public"],
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

`generatedTypes` may be `false`, `"auto"`, or an object. Auto-detection recognizes common `database.types.ts` locations. `{supabase}` resolves to the project's local binary when present and otherwise to `supabase` on `PATH`.

### Verification checks

The default plan is:

```json
[
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
    "command": "{supabase} db lint --level error",
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

Projects using a recent CLI can add a required `supabase db advisors` check. Application tests, typechecks, or builds can be added the same way. Supported `when` values are `always`, `supabase-changed`, and `database-tests-present`.

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
| `SUPA008` | error | An exposed view lacks `security_invoker`. |
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
