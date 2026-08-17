export type Severity = "error" | "warning" | "info"
export type RuleLevel = Severity | "off"
export type ScanScope = "changed" | "all"

export type RuleId =
  | "SUPA001"
  | "SUPA002"
  | "SUPA003"
  | "SUPA004"
  | "SUPA005"
  | "SUPA006"
  | "SUPA007"
  | "SUPA008"
  | "SUPA009"
  | "SUPA010"
  | "SUPA011"
  | "SUPA012"
  | "SUPA013"
  | "SUPA014"
  | "SUPA015"
  | "SUPA016"
  | "SUPA017"

export interface Finding {
  ruleId: RuleId
  severity: Severity
  message: string
  file: string
  line: number
  object?: string
  suggestion?: string
}

export interface SqlSource {
  path: string
  content: string
}

export interface ScanSummary {
  errors: number
  warnings: number
  info: number
}

export interface ScanReport {
  findings: Finding[]
  files: string[]
  createdTables: string[]
  hasRlsChanges: boolean
  summary: ScanSummary
}

export type CheckWhen = "always" | "supabase-changed" | "database-tests-present"

/**
 * Several Supabase CLI commands report by output rather than exit code —
 * `db diff` prints a schema delta and still exits 0 — so a check can assert on
 * what the command wrote.
 */
export interface CheckExpectation {
  stdoutMustBeEmpty?: boolean
  stdoutMustNotMatch?: string
  outputMustNotMatch?: string
  message?: string
}

export interface CheckConfig {
  id: string
  name: string
  command: string
  required: boolean
  when: CheckWhen
  expect?: CheckExpectation
  /** Opt in to a check that writes to a linked or remote database. */
  allowRemoteWrites?: boolean
}

export interface GeneratedTypesConfig {
  path: string
  command: string
  required: boolean
}

export interface GuardConfig {
  mode: "block" | "warn" | "off"
  commands: string[]
  requireFreshEvidence: boolean
  blockOnWarnings: boolean
  approvalMinutes: number
}

export interface SupashipConfig {
  $schema?: string
  sqlDirectories: string[]
  testDirectories: string[]
  exposedSchemas: string[]
  baseRef?: string
  supabaseCommand: string
  generatedTypes: false | "auto" | GeneratedTypesConfig
  checks: CheckConfig[]
  guard: GuardConfig
  rules: Partial<Record<RuleId, RuleLevel>>
  stateFile: string
  maxOutputChars: number
  /** Read the CLI and local stack before running Supabase checks. */
  preflight: boolean
}

export interface ResolvedConfig extends Omit<SupashipConfig, "generatedTypes" | "rules"> {
  generatedTypes: false | GeneratedTypesConfig
  rules: Record<RuleId, RuleLevel>
}

export interface ProjectSnapshot {
  root: string
  scope: ScanScope
  baseRef?: string
  changedPaths: string[]
  deletedPaths: string[]
  sqlSources: SqlSource[]
  testFiles: string[]
  supabaseChanged: boolean
  fingerprint: string
}

export type SkipReason = "not-applicable" | "unsupported" | "preflight"

export interface CheckResult {
  id: string
  name: string
  command: string
  required: boolean
  status: "passed" | "failed" | "skipped"
  exitCode?: number
  durationMs: number
  output?: string
  message?: string
  skipReason?: SkipReason
  /** A concrete next step derived from the CLI's own output. */
  remedy?: string
}

export type PreflightStatus = "ok" | "warning" | "blocked" | "unknown"

export type PreflightId = "cli" | "project" | "docker" | "stack" | "link" | "capabilities"

export interface PreflightCheck {
  id: PreflightId
  status: PreflightStatus
  detail: string
  remedy?: string
}

export interface CliCapabilities {
  advisors: boolean
  lintFailOn: boolean
  declarativeSchema: boolean
}

export interface CliEnvironment {
  command: string
  version?: string
  capabilities: CliCapabilities
  checks: PreflightCheck[]
  linkedProjectRef?: string
  /** False when a blocking problem means local checks cannot succeed. */
  ready: boolean
}

export interface Approval {
  fingerprint: string
  reason: string
  approvedAt: string
  expiresAt: string
}

export interface EvidenceState {
  schemaVersion: 1
  fingerprint?: string
  verifiedAt?: string
  checks: CheckResult[]
  approval?: Approval
  environment?: CliEnvironment
}

export interface ShipReport {
  ready: boolean
  approved: boolean
  scope: ScanScope
  fingerprint: string
  baseRef?: string
  changedPaths: string[]
  scan: ScanReport
  checks: CheckResult[]
  missingEvidence: string[]
  /** Required checks the installed CLI cannot run; recorded, never silent. */
  unsupportedChecks: string[]
  staleEvidence: boolean
  approval?: Approval
  environment?: CliEnvironment
}

export interface CommandResult {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}
