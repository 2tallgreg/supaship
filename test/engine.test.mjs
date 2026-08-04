import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { isGuardedCommand } from "../dist/commands.js"
import { loadConfig } from "../dist/config.js"
import { SupashipEngine } from "../dist/engine.js"

const packageRoot = path.resolve(import.meta.dirname, "..")
const safeSql = await readFile(
  path.join(packageRoot, "test/fixtures/safe/20260803000000_appraisals.sql"),
  "utf8",
)

function git(root, ...args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" })
}

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "supaship-engine-"))
  git(root, "init", "-b", "main")
  git(root, "config", "user.name", "Supaship Test")
  git(root, "config", "user.email", "supaship@example.test")
  await writeFile(path.join(root, "README.md"), "fixture\n")
  git(root, "add", "README.md")
  git(root, "commit", "-m", "initial")
  git(root, "switch", "-c", "feature")

  await mkdir(path.join(root, "supabase/migrations"), { recursive: true })
  await mkdir(path.join(root, "supabase/tests"), { recursive: true })
  await writeFile(path.join(root, "supabase/migrations/20260803000000_appraisals.sql"), safeSql)
  await writeFile(
    path.join(root, "supabase/tests/appraisals.test.sql"),
    "begin; select plan(1); select ok(true, 'fixture'); select * from finish(); rollback;\n",
  )
  git(root, "add", "supabase")
  git(root, "commit", "-m", "add safe schema")

  const config = loadConfig(root, {
    baseRef: "main",
    generatedTypes: false,
    checks: [
      {
        id: "fixture-check",
        name: "Fixture verification",
        command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
        required: true,
        when: "supabase-changed",
      },
    ],
  })
  return { root, config, engine: new SupashipEngine(root, config) }
}

test("requires fresh evidence, records it, and invalidates it after relevant changes", async () => {
  const { root, engine } = await project()

  const before = await engine.inspect()
  assert.equal(before.ready, false)
  assert.deepEqual(before.missingEvidence, ["fixture-check"])
  assert.equal(before.scan.summary.errors, 0)

  const verified = await engine.verify()
  assert.equal(verified.ready, true)
  assert.equal(verified.checks.find((check) => check.id === "fixture-check")?.status, "passed")

  const migration = path.join(root, "supabase/migrations/20260803000000_appraisals.sql")
  await writeFile(migration, `${safeSql}\n-- a new relevant change\n`)
  const stale = await engine.inspect()
  assert.equal(stale.ready, false)
  assert.equal(stale.staleEvidence, true)
  assert.deepEqual(stale.missingEvidence, ["fixture-check"])
  assert.notEqual(stale.fingerprint, verified.fingerprint)
})

test("approval is explicit, fingerprint-bound, and time-limited", async () => {
  const { root, engine } = await project()
  const approved = await engine.approve("Reviewed the intentional rollout manually", 10)
  assert.equal(approved.ready, true)
  assert.equal(approved.approved, true)

  const migration = path.join(root, "supabase/migrations/20260803000000_appraisals.sql")
  await writeFile(migration, `${safeSql}\n-- invalidate approval\n`)
  const changed = await engine.inspect()
  assert.equal(changed.approved, false)
  assert.equal(changed.ready, false)
})

test("guard patterns cover shipping commands but permit dry runs", async () => {
  const { config } = await project()
  assert.equal(isGuardedCommand("supabase db push", config), true)
  assert.equal(isGuardedCommand("git push origin feature", config), true)
  assert.equal(isGuardedCommand("gh pr create --fill", config), true)
  assert.equal(isGuardedCommand("supabase db push --dry-run", config), false)
  assert.equal(isGuardedCommand("git status", config), false)
})
