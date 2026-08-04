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
