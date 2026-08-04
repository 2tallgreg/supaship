import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { loadConfig } from "../dist/config.js"
import { scanSql } from "../dist/sql-scanner.js"

const root = path.resolve(import.meta.dirname, "..")
const config = loadConfig(root, { generatedTypes: false })

async function fixture(group, name) {
  const relative = `test/fixtures/${group}/${name}`
  return { path: relative, content: await readFile(path.join(root, relative), "utf8") }
}

test("accepts a least-privilege migration with RLS, invoker view, and locked-down helper", async () => {
  const source = await fixture("safe", "20260803000000_appraisals.sql")
  const report = scanSql([source], config)

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.deepEqual(report.createdTables, ["public.appraisals"])
  assert.equal(report.hasRlsChanges, true)
})

test("finds security, RLS, privilege, view, and destructive-DDL hazards", async () => {
  const source = await fixture("unsafe", "20260803000000_unsafe.sql")
  const report = scanSql([source], config)
  const ids = new Set(report.findings.map((finding) => finding.ruleId))

  for (const expected of [
    "SUPA001",
    "SUPA002",
    "SUPA004",
    "SUPA005",
    "SUPA006",
    "SUPA007",
    "SUPA008",
    "SUPA009",
    "SUPA010",
    "SUPA011",
    "SUPA012",
    "SUPA013",
    "SUPA014",
    "SUPA015",
    "SUPA016",
  ]) {
    assert.ok(ids.has(expected), `expected ${expected}; got ${[...ids].join(", ")}`)
  }
  assert.ok(report.summary.errors >= 8)
  assert.ok(report.findings.every((finding) => finding.line > 0))
})

test("comments do not trigger destructive-DDL findings", () => {
  const source = {
    path: "supabase/migrations/comment_only.sql",
    content: "-- drop table public.users;\n/* alter table auth.users add column bad int; */\n",
  }
  const report = scanSql([source], config)
  assert.deepEqual(report.findings, [])
})

function scan(content) {
  return scanSql([{ path: "supabase/migrations/inline.sql", content }], config)
}

test("a constrained ALL policy without WITH CHECK needs the explicit clause but is not open", () => {
  const report = scan(`
    create table public.notes (id uuid primary key, owner uuid);
    alter table public.notes enable row level security;
    grant select, insert, update on table public.notes to authenticated;
    create policy notes_all on public.notes for all to authenticated
      using ((select auth.uid()) = owner);
  `)
  const ids = report.findings.map((finding) => finding.ruleId)
  assert.deepEqual(ids, ["SUPA004"])
})

test("literally-open write policies are flagged and open SELECT policies are not", () => {
  const open = scan(`
    create table public.notes (id uuid primary key, owner uuid);
    alter table public.notes enable row level security;
    grant all on table public.notes to authenticated;
    create policy notes_insert on public.notes for insert to authenticated with check (true);
  `)
  assert.ok(open.findings.some((finding) => finding.ruleId === "SUPA005"))

  const publicRead = scan(`
    create table public.notes (id uuid primary key, owner uuid);
    alter table public.notes enable row level security;
    grant select on table public.notes to anon;
    create policy notes_read on public.notes for select to anon using (true);
  `)
  assert.ok(!publicRead.findings.some((finding) => finding.ruleId === "SUPA005"))
})

test("unqualified grants and revokes count as Data API access decisions", () => {
  const report = scan(`
    create table public.notes (id uuid primary key, owner uuid);
    alter table public.notes enable row level security;
    revoke all on notes from anon, authenticated;
    create policy notes_read on public.notes for select to authenticated
      using ((select auth.uid()) = owner);
  `)
  assert.deepEqual(report.findings, [])
})

test("exposed materialized views need an explicit access decision", () => {
  const undecided = scan("create materialized view public.stats as select 1 as total;")
  assert.deepEqual(undecided.findings.map((finding) => finding.ruleId), ["SUPA008"])

  const revoked = scan(`
    create materialized view public.stats as select 1 as total;
    revoke select on public.stats from anon, authenticated;
  `)
  assert.deepEqual(revoked.findings, [])
})

test("managed-schema protection covers vault and extensions", () => {
  const report = scan(`
    alter table vault.secrets add column exposed boolean;
    create function extensions.sneaky() returns void language sql as $$ select 1 $$;
  `)
  const ids = report.findings.map((finding) => finding.ruleId)
  assert.deepEqual([...new Set(ids)], ["SUPA015"])
})
