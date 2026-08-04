import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
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
      command: "{supabase} db lint --level error",
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
  return command.replaceAll("{supabase}", config.supabaseCommand)
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
