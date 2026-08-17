#!/usr/bin/env node
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { loadConfig } from "./config.js"
import { SupashipEngine } from "./engine.js"
import { formatEnvironmentReport, formatShipReport } from "./format.js"
import type { ScanScope } from "./types.js"

const HELP = `Supaship — deterministic Supabase shipping checks

Usage:
  supaship status [--all] [--json] [--config <path>]
  supaship verify [--all] [--json] [--config <path>]
  supaship doctor [--json] [--config <path>]
  supaship init

Commands:
  status   Inspect SQL and existing verification evidence without changing anything.
  verify   Run configured local checks and record fingerprinted evidence.
  doctor   Report the Supabase CLI version, local stack state, and available commands.
  init     Create supaship.config.json in the current directory.
`

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

async function init(root: string): Promise<void> {
  const target = path.join(root, "supaship.config.json")
  if (existsSync(target)) throw new Error("supaship.config.json already exists.")
  const example = {
    $schema: "./node_modules/opencode-supaship/schema.json",
    sqlDirectories: ["supabase/migrations", "supabase/schemas"],
    testDirectories: ["supabase/tests"],
    exposedSchemas: ["public"],
    generatedTypes: "auto",
    preflight: true,
    guard: {
      mode: "block",
      requireFreshEvidence: true,
      blockOnWarnings: false,
      approvalMinutes: 30,
    },
  }
  await writeFile(target, `${JSON.stringify(example, null, 2)}\n`, "utf8")
  process.stdout.write(`Created ${target}\n`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  if (!command || command === "help" || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP)
    return
  }

  const root = process.cwd()
  if (command === "init") {
    await init(root)
    return
  }
  if (command !== "status" && command !== "verify" && command !== "doctor") {
    throw new Error(`Unknown command: ${command}\n\n${HELP}`)
  }

  const configPath = valueAfter(args, "--config")
  if (args.includes("--config") && !configPath) throw new Error("--config requires a path.")
  const config = loadConfig(root, configPath ? { config: configPath } : {})
  const engine = new SupashipEngine(root, config)

  if (command === "doctor") {
    const environment = await engine.doctor()
    process.stdout.write(
      args.includes("--json")
        ? `${JSON.stringify(environment, null, 2)}\n`
        : `${formatEnvironmentReport(environment)}\n`,
    )
    if (!environment.ready) process.exitCode = 1
    return
  }

  const scope: ScanScope = args.includes("--all") ? "all" : "changed"
  const report = command === "verify" ? await engine.verify({ scope }) : await engine.inspect(scope)

  process.stdout.write(args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : `${formatShipReport(report)}\n`)
  if (!report.ready) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`supaship: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
