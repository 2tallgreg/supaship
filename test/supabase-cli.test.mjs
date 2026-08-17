import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { isGuardedCommand } from "../dist/commands.js"
import { loadConfig } from "../dist/config.js"
import { SupashipEngine } from "../dist/engine.js"
import { diagnose, usesSupabaseCli, writesToRemoteDatabase } from "../dist/supabase-cli.js"

const node = JSON.stringify(process.execPath)

function git(root, ...args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" })
}

/** A git project with one migration, so `supabase-changed` checks apply. */
async function project(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "supaship-cli-"))
  git(root, "init", "-b", "main")
  git(root, "config", "user.name", "Supaship Test")
  git(root, "config", "user.email", "supaship@example.test")
  await writeFile(path.join(root, "README.md"), "fixture\n")
  git(root, "add", "README.md")
  git(root, "commit", "-m", "initial")
  git(root, "switch", "-c", "feature")

  await mkdir(path.join(root, "supabase/migrations"), { recursive: true })
  await writeFile(
    path.join(root, "supabase/migrations/20260803000000_notes.sql"),
    "create table public.notes (id bigint primary key);\nalter table public.notes enable row level security;\nrevoke all on public.notes from anon, authenticated;\n",
  )
  git(root, "add", ".")
  git(root, "commit", "-m", "add notes")

  const config = loadConfig(root, {
    baseRef: "main",
    generatedTypes: false,
    testDirectories: [],
    preflight: false,
    ...overrides,
  })
  return { root, config, engine: new SupashipEngine(root, config) }
}

test("remote-writing Supabase commands are classified, read-only remote commands are not", () => {
  assert.equal(writesToRemoteDatabase("supabase db push"), true)
  assert.equal(writesToRemoteDatabase("npx supabase migration repair --status applied 20260101"), true)
  assert.equal(writesToRemoteDatabase("supabase functions deploy send-email"), true)
  assert.equal(writesToRemoteDatabase("supabase secrets set FOO=bar"), true)
  assert.equal(writesToRemoteDatabase("supabase db reset --linked"), true)
  assert.equal(writesToRemoteDatabase("supabase db query --linked 'delete from users'"), true)

  assert.equal(writesToRemoteDatabase("supabase db reset"), false)
  assert.equal(writesToRemoteDatabase("supabase db lint --linked --level error"), false)
  assert.equal(writesToRemoteDatabase("supabase db advisors --linked --type security"), false)
  assert.equal(writesToRemoteDatabase("supabase migration list --linked"), false)
  assert.equal(writesToRemoteDatabase("supabase test db"), false)
})

test("Supabase CLI invocations are recognized in every common form", () => {
  assert.equal(usesSupabaseCli("{supabase} db reset"), true)
  assert.equal(usesSupabaseCli("supabase db reset"), true)
  assert.equal(usesSupabaseCli("npx supabase db reset"), true)
  assert.equal(usesSupabaseCli("./node_modules/.bin/supabase db reset"), true)
  assert.equal(usesSupabaseCli("npm run test:unit"), false)
  assert.equal(usesSupabaseCli("node -e \"process.exit(0)\""), false)
})

test("CLI failures map to the next command the user should run", () => {
  assert.match(diagnose("bash: supabase: command not found"), /npm install supabase/)
  assert.match(diagnose('Error: unknown command "advisors" for "supabase db"'), /Upgrade the Supabase CLI/)
  assert.match(diagnose("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"), /container runtime/)
  assert.match(diagnose("Have you run supabase start?"), /supabase start/)
  assert.match(
    diagnose("Remote migration versions not found in local migrations directory."),
    /migration repair --status reverted/,
  )
  assert.equal(diagnose("some unrelated failure"), undefined)
  assert.equal(diagnose(undefined), undefined)
})

test("verification checks may not write to a remote database without an explicit opt-in", async () => {
  await assert.rejects(
    project({ checks: [{ id: "push", name: "Push", command: "{supabase} db push", required: true, when: "always" }] }),
    /writes to a linked or remote database/,
  )

  const { config } = await project({
    checks: [
      {
        id: "push",
        name: "Push",
        command: "{supabase} db push",
        required: true,
        when: "always",
        allowRemoteWrites: true,
      },
    ],
  })
  assert.equal(config.checks[0].allowRemoteWrites, true)
})

test("the guard covers remote-mutating Supabase CLI commands and leaves local ones alone", async () => {
  const { config } = await project({ checks: [] })

  assert.equal(isGuardedCommand("supabase db push", config), true)
  assert.equal(isGuardedCommand("supabase db reset --linked", config), true)
  assert.equal(isGuardedCommand("supabase migration up --db-url $PROD", config), true)
  assert.equal(isGuardedCommand("supabase migration repair --status applied 20260101", config), true)
  assert.equal(isGuardedCommand("supabase functions deploy send-email", config), true)
  assert.equal(isGuardedCommand("supabase secrets set STRIPE_KEY=sk_live", config), true)
  assert.equal(isGuardedCommand("supabase config push", config), true)
  assert.equal(isGuardedCommand("supabase branches create staging", config), true)

  // The local development loop must stay unguarded.
  assert.equal(isGuardedCommand("supabase db reset", config), false)
  assert.equal(isGuardedCommand("supabase db diff --local --schema public", config), false)
  assert.equal(isGuardedCommand("supabase migration up", config), false)
  assert.equal(isGuardedCommand("supabase db lint --linked --level error", config), false)
  assert.equal(isGuardedCommand("supabase migration list --linked", config), false)
  assert.equal(isGuardedCommand("supabase db push --dry-run", config), false)
})

test("{schemas} resolves to the configured exposed schemas", async () => {
  const { engine } = await project({
    exposedSchemas: ["public", "Billing"],
    checks: [
      {
        id: "db-drift",
        name: "Drift",
        command: "{supabase} db diff --local --schema {schemas}",
        required: false,
        when: "always",
      },
    ],
  })
  const plan = await engine.verificationPlan()
  assert.equal(plan[0].command.endsWith("db diff --local --schema public,billing"), true)
})

test("a check that exits zero still fails when its output violates an expectation", async () => {
  const { engine } = await project({
    checks: [
      {
        id: "db-drift",
        name: "Local database matches committed migrations",
        command: `${node} -e "console.log('create table public.orphan (id int);')"`,
        required: false,
        when: "always",
        expect: {
          stdoutMustNotMatch: "^\\s*(?:create|alter|drop)\\b",
          message: "The local database has schema changes that are not in a migration.",
        },
      },
    ],
  })

  const report = await engine.verify()
  const drift = report.checks.find((check) => check.id === "db-drift")
  assert.equal(drift.status, "failed")
  assert.equal(drift.exitCode, 0)
  assert.match(drift.message, /not in a migration/)
})

test("an expectation that holds leaves the check passing", async () => {
  const { engine } = await project({
    checks: [
      {
        id: "db-drift",
        name: "Local database matches committed migrations",
        command: `${node} -e "console.error('Diffing schemas: public')"`,
        required: false,
        when: "always",
        expect: { stdoutMustNotMatch: "^\\s*(?:create|alter|drop)\\b" },
      },
    ],
  })

  const report = await engine.verify()
  assert.equal(report.checks.find((check) => check.id === "db-drift").status, "passed")
})

test("a check the installed CLI cannot run is recorded as unsupported, not silently passed", async () => {
  const { engine } = await project({
    checks: [
      {
        id: "db-advisors",
        name: "Supabase security advisors",
        command: `${node} -e "console.error('Error: unknown command \\"advisors\\" for \\"supabase db\\"'); process.exit(1)"`,
        required: true,
        when: "always",
      },
    ],
  })

  const report = await engine.verify()
  const advisors = report.checks.find((check) => check.id === "db-advisors")
  assert.equal(advisors.status, "skipped")
  assert.equal(advisors.skipReason, "unsupported")
  assert.match(advisors.remedy, /Upgrade the Supabase CLI/)

  // Unfixable without a CLI upgrade, so it does not block — but it is named.
  assert.deepEqual(report.missingEvidence, [])
  assert.deepEqual(report.unsupportedChecks, ["db-advisors"])
  assert.equal(report.ready, true)
})

test("a genuine check failure still blocks and carries a remedy", async () => {
  const { engine } = await project({
    checks: [
      {
        id: "db-reset",
        name: "Rebuild the local database",
        command: `${node} -e "console.error('failed to connect to postgres: connection refused'); process.exit(1)"`,
        required: true,
        when: "always",
      },
    ],
  })

  const report = await engine.verify()
  const reset = report.checks.find((check) => check.id === "db-reset")
  assert.equal(reset.status, "failed")
  assert.match(reset.remedy, /supabase start/)
  assert.deepEqual(report.missingEvidence, ["db-reset"])
  assert.equal(report.ready, false)
})

test("preflight reports a missing CLI instead of running every Supabase check against it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "supaship-preflight-"))
  const missing = path.join(root, "bin", "supabase")

  const { engine } = await project({
    supabaseCommand: missing,
    preflight: true,
    checks: [
      {
        id: "db-reset",
        name: "Rebuild the local database from migrations",
        command: "{supabase} db reset",
        required: true,
        when: "always",
      },
    ],
  })

  const report = await engine.verify()
  const reset = report.checks.find((check) => check.id === "db-reset")
  assert.equal(reset.status, "failed")
  assert.equal(reset.durationMs, 0, "the check must not have been executed")
  assert.match(reset.message, /Not run:/)
  assert.match(reset.remedy, /Install the Supabase CLI/)
  assert.equal(report.environment.ready, false)
  assert.equal(report.environment.checks[0].id, "cli")
})

test("preflight is skipped when no check touches the Supabase CLI", async () => {
  const { engine } = await project({
    supabaseCommand: "definitely-not-installed-supabase",
    preflight: true,
    checks: [
      {
        id: "app-tests",
        name: "Application tests",
        command: `${node} -e "process.exit(0)"`,
        required: true,
        when: "always",
      },
    ],
  })

  const report = await engine.verify()
  assert.equal(report.environment, undefined)
  assert.equal(report.checks.find((check) => check.id === "app-tests").status, "passed")
  assert.equal(report.ready, true)
})
