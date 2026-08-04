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

export interface CheckConfig {
  id: string
  name: string
  command: string
  required: boolean
  when: CheckWhen
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
  staleEvidence: boolean
  approval?: Approval
}

export interface CommandResult {
  command: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}
