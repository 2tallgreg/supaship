# Changelog

## 0.2.0 — 2026-08-17

Supabase CLI integration.

### Added

- `supaship doctor` and the `supaship_doctor` tool report the CLI version, container stack state, linked project, and which subcommands the installed CLI has, with a fix for every problem found. Both run only a read-only allowlist: `--version`, `status`, and `--help`.
- Preflight: with `preflight` enabled (the default), Supaship reads the CLI and stack once before running Supabase checks. A stopped Docker daemon now costs one immediate, explained failure instead of a stalled `db reset` per check. Preflight is skipped when no applicable check invokes the CLI.
- Failed checks carry a remedy derived from the CLI's own output — missing CLI, Docker down, stack not started, not linked, not logged in, port in use, migration history mismatch, or a CLI too old for the command.
- Checks accept an `expect` block (`stdoutMustBeEmpty`, `stdoutMustNotMatch`, `outputMustNotMatch`, `message`) for CLI commands that report by output rather than exit code.
- `{schemas}` in any command resolves to the comma-separated `exposedSchemas` list.
- New default check `db-drift` runs `supabase db diff --local` **before** `db reset` and reports local schema changes that no migration contains — `db reset` would otherwise discard them silently. Not required by default.
- New default check `db-advisors` runs `supabase db advisors --local --type security --fail-on error`, re-checking against the rebuilt database what static analysis can only infer from SQL text.

### Changed

- The default `db-lint` check is now `supabase db lint --local --level error --fail-on error`. `--level` only controls what is printed, so without `--fail-on` the check passed while lint reported errors.
- The guard also intercepts `supabase db reset`/`db query` with `--linked` or `--db-url`, `supabase migration up`/`down`/`squash` with `--linked` or `--db-url`, `supabase migration repair`, `supabase functions deploy`/`delete`, `supabase secrets set`/`unset`, `supabase config push`, and `supabase branches create`/`delete`/`update`. The local development loop stays unguarded.
- A required check the installed CLI cannot run is recorded as unsupported and named in the report instead of blocking a repository that no change can unblock.
- The system prompt states which Supabase CLI commands are local, which default to the linked project, and to run `supaship_doctor` before retrying a failed Supabase command.

### Fixed

- A verification check that writes to a linked or remote database is now rejected when the config loads. Verification runs without the guard in front of it, so a `db push` check would have shipped straight to production. Read-only remote checks stay allowed; `"allowRemoteWrites": true` opts back in deliberately.

## 0.1.1 — 2026-08-04

- Guard: `--dry-run` now only exempts its own command in a compound line, so `git push --dry-run && git push` is blocked.
- Custom `sqlDirectories` and `testDirectories` outside `supabase/` now mark the project as changed, so verification evidence is still required.
- SUPA005 no longer flags UPDATE/ALL policies whose USING expression is constrained but WITH CHECK is omitted; Postgres reuses USING for new rows, and SUPA004 still asks for the explicit clause.
- Unqualified `GRANT`/`REVOKE` statements on default-schema objects now count as Data API access decisions for SUPA002 and SUPA011.
- SUPA008 reports exposed materialized views, which cannot use `security_invoker`, unless their access is explicitly granted or revoked.
- SUPA015 also covers the `vault`, `extensions`, `graphql`, `net`, and other Supabase-managed schemas.
- `supaship_approve` fails if the project changed between the permission prompt and the recorded approval.
- Aborting verification now terminates the full process group of a running check instead of only the shell.
- npm: the package builds on `prepack` and declares repository metadata.

## 0.1.0 — 2026-08-03

- Initial OpenCode plugin and CLI.
- Static Supabase migration and RLS scanner with 17 configurable rules.
- Fingerprinted local verification evidence.
- Generated TypeScript definition comparison and synchronization.
- Guarded database push, Git push, PR creation, and PR merge commands.
- Explicit, time-limited human overrides bound to one fingerprint.
