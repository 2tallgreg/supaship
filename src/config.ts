import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { writesToRemoteDatabase } from "./supabase-cli.js"
import type {
  GeneratedTypesConfig,
  ResolvedConfig,
  RuleId,
  RuleLevel,
  SupashipConfig,
} from "./types.js"

export const RULE_IDS: RuleId[] = [
  "SUPA001",
  "SUPA002",
  "SUPA003",
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
  "SUPA017",
]

export const DEFAULT_RULES: Record<RuleId, RuleLevel> = {
  SUPA001: "error",
  SUPA002: "error",
  SUPA003: "error",
  SUPA004: "error",
  SUPA005: "error",
  SUPA006: "warning",
  SUPA007: "error",
  SUPA008: "error",
  SUPA009: "error",
  SUPA010: "error",
  SUPA011: "warning",
  SUPA012: "warning",
  SUPA013: "warning",
  SUPA014: "error",
  SUPA015: "error",
  SUPA016: "error",
  SUPA017: "warning",
}

export const DEFAULT_CONFIG: SupashipConfig = {
  sqlDirectories: ["supabase/migrations", "supabase/schemas"],
  testDirectories: ["supabase/tests"],
  exposedSchemas: ["public"],
  supabaseCommand: "auto",
  generatedTypes: "auto",
  checks: [
    // Runs before db-reset on purpose: `db reset` recreates the local database
    // from migrations, so any uncommitted local schema change is gone after it.
    {
      id: "db-drift",
      name: "Local database matches committed migrations",
      command: "{supabase} db diff --local --schema {schemas}",
      required: false,
      when: "supabase-changed",
      expect: {
        stdoutMustNotMatch: String.raw`^\s*(?:create|alter|drop|revoke|grant)\b`,
        message:
          "The local database has schema changes that are not in a migration. `supabase db reset` will discard them — capture them first with `supabase db diff -f <name>`.",
      },
    },
    {
      id: "db-reset",
      name: "Rebuild the local database from migrations",
      command: "{supabase} db reset",
      required: true,
      when: "supabase-changed",
    },
    {
      id: "db-lint",
      name: "Lint database functions and schema",
      command: "{supabase} db lint --local --level error --fail-on error",
      required: true,
      when: "supabase-changed",
    },
    // `db advisors` re-checks against the rebuilt database what the static
    // scanner can only infer from SQL text: missing RLS, exposed auth.users,
    // definer views, unindexed foreign keys.
    {
      id: "db-advisors",
      name: "Supabase security advisors on the local database",
      command: "{supabase} db advisors --local --type security --fail-on error",
      required: true,
      when: "supabase-changed",
    },
    {
      id: "db-tests",
      name: "Run pgTAP database tests",
      command: "{supabase} test db",
      required: true,
      when: "database-tests-present",
    },
  ],
  guard: {
    mode: "block",
    commands: [
      String.raw`\bsupabase\s+db\s+push\b`,
      // Local by default; only the remote-targeting forms are shipping actions.
      String.raw`\bsupabase\s+db\s+(?:reset|query)\b(?=[^\n]*--(?:linked|db-url))`,
      String.raw`\bsupabase\s+migration\s+(?:up|down|squash)\b(?=[^\n]*--(?:linked|db-url))`,
      String.raw`\bsupabase\s+migration\s+repair\b`,
      String.raw`\bsupabase\s+functions\s+(?:deploy|delete)\b`,
      String.raw`\bsupabase\s+secrets\s+(?:set|unset)\b`,
      String.raw`\bsupabase\s+config\s+push\b`,
      String.raw`\bsupabase\s+branches\s+(?:create|delete|update)\b`,
      String.raw`\bgit\s+push\b`,
      String.raw`\bgh\s+pr\s+(?:create|merge)\b`,
    ],
    requireFreshEvidence: true,
    blockOnWarnings: false,
    approvalMinutes: 30,
  },
  rules: DEFAULT_RULES,
  stateFile: ".opencode/supaship/state.json",
  maxOutputChars: 8_000,
  preflight: true,
}

const TYPE_CANDIDATES = [
  "src/types/database.types.ts",
  "src/types/database-generated.types.ts",
  "src/types/supabase.ts",
  "database.types.ts",
  "types/database.types.ts",
]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) return (override ?? base) as T
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    const current = result[key]
    result[key] = isObject(current) && isObject(value) ? deepMerge(current, value) : value
  }
  return result as T
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!isObject(parsed)) throw new Error("the top-level value must be an object")
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to read Supaship config at ${file}: ${message}`)
  }
}

function detectConfigPath(root: string, configured?: unknown): string | undefined {
  if (typeof configured === "string") return path.resolve(root, configured)
  for (const candidate of ["supaship.config.json", ".supaship.json"]) {
    const absolute = path.join(root, candidate)
    if (existsSync(absolute)) return absolute
  }
  return undefined
}

function resolveSupabaseCommand(root: string, configured: string): string {
  if (configured !== "auto") return configured
  const executable = process.platform === "win32" ? "supabase.cmd" : "supabase"
  const local = path.join(root, "node_modules", ".bin", executable)
  return existsSync(local) ? `./node_modules/.bin/${executable}` : "supabase"
}

function detectGeneratedTypes(root: string): GeneratedTypesConfig | false {
  for (const candidate of TYPE_CANDIDATES) {
    if (existsSync(path.join(root, candidate))) {
      return {
        path: candidate,
        command: "{supabase} gen types typescript --local",
        required: true,
      }
    }
  }
  return false
}

/**
 * Safety classification reads the command as written, not as resolved: the
 * resolved binary may be a path like `./node_modules/.bin/supabase`, and a
 * project-local wrapper would otherwise hide `db push` from the check.
 */
function canonicalCommand(command: string): string {
  return command.replaceAll("{supabase}", "supabase")
}

function validate(config: ResolvedConfig): void {
  if (!config.sqlDirectories.length) throw new Error("sqlDirectories must contain at least one path")
  if (!config.exposedSchemas.length) throw new Error("exposedSchemas must contain at least one schema")
  if (!Number.isFinite(config.maxOutputChars) || config.maxOutputChars < 1_000) {
    throw new Error("maxOutputChars must be at least 1000")
  }
  const ids = new Set<string>()
  for (const check of config.checks) {
    if (!check.id || !check.command) throw new Error("Every check needs a non-empty id and command")
    if (ids.has(check.id)) throw new Error(`Duplicate check id: ${check.id}`)
    ids.add(check.id)
    // Verification runs without the guard in front of it, so a remote-writing
    // check would push straight to production during `supaship verify`.
    if (!check.allowRemoteWrites && writesToRemoteDatabase(canonicalCommand(check.command))) {
      throw new Error(
        `Check ${check.id} writes to a linked or remote database: ${check.command}. Target the local stack instead, or set "allowRemoteWrites": true on that check to accept the risk.`,
      )
    }
    for (const [field, pattern] of [
      ["stdoutMustNotMatch", check.expect?.stdoutMustNotMatch],
      ["outputMustNotMatch", check.expect?.outputMustNotMatch],
    ] as const) {
      if (pattern === undefined) continue
      try {
        new RegExp(pattern, "im")
      } catch (error) {
        throw new Error(`Check ${check.id} has an invalid ${field} pattern: ${String(error)}`)
      }
    }
  }
  if (config.generatedTypes && writesToRemoteDatabase(canonicalCommand(config.generatedTypes.command))) {
    throw new Error(`generatedTypes.command writes to a remote database: ${config.generatedTypes.command}`)
  }
  for (const pattern of config.guard.commands) {
    try {
      new RegExp(pattern, "i")
    } catch (error) {
      throw new Error(`Invalid guard command pattern ${JSON.stringify(pattern)}: ${String(error)}`)
    }
  }
  for (const [ruleId, level] of Object.entries(config.rules)) {
    if (!RULE_IDS.includes(ruleId as RuleId)) throw new Error(`Unknown Supaship rule: ${ruleId}`)
    if (!["error", "warning", "info", "off"].includes(level)) {
      throw new Error(`Invalid level for ${ruleId}: ${String(level)}`)
    }
  }
}

export function materializeCommand(command: string, config: ResolvedConfig): string {
  return command
    .replaceAll("{supabase}", config.supabaseCommand)
    .replaceAll("{schemas}", config.exposedSchemas.join(","))
}

export function loadConfig(
  root: string,
  pluginOptions: Record<string, unknown> = {},
): ResolvedConfig {
  const configPath = detectConfigPath(root, pluginOptions.config)
  const fileConfig = configPath && existsSync(configPath) ? readJson(configPath) : {}
  const inlineOptions = { ...pluginOptions }
  delete inlineOptions.config

  let merged = deepMerge(DEFAULT_CONFIG, fileConfig)
  merged = deepMerge(merged, inlineOptions)

  const generatedTypes =
    merged.generatedTypes === "auto"
      ? detectGeneratedTypes(root)
      : merged.generatedTypes

  const resolved: ResolvedConfig = {
    ...merged,
    exposedSchemas: merged.exposedSchemas.map((schema) => schema.toLowerCase()),
    supabaseCommand: resolveSupabaseCommand(root, merged.supabaseCommand),
    generatedTypes,
    rules: { ...DEFAULT_RULES, ...merged.rules },
  }

  validate(resolved)
  return resolved
}
