# Changelog

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
