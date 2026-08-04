import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { materializeCommand } from "./config.js"
import { runCommand } from "./commands.js"
import { activeApproval, emptyEvidence, loadEvidence, makeApproval, saveEvidence } from "./evidence.js"
import { createSnapshot } from "./project.js"
import { scanSql } from "./sql-scanner.js"
import type {
  CheckConfig,
  CheckResult,
  CommandResult,
  EvidenceState,
  Finding,
  ProjectSnapshot,
  ResolvedConfig,
  ScanReport,
  ScanScope,
  ShipReport,
} from "./types.js"

export interface VerifyOptions {
  scope?: ScanScope
  signal?: AbortSignal
  onCheckStart?: (check: CheckConfig | { id: "generated-types"; name: string; command: string }) => void
}

export interface SyncTypesResult {
  path: string
  changed: boolean
  command: CommandResult
}

function recalculateSummary(report: ScanReport): ScanReport {
  const summary = report.findings.reduce(
    (counts, finding) => {
      if (finding.severity === "error") counts.errors += 1
      else if (finding.severity === "warning") counts.warnings += 1
      else counts.info += 1
      return counts
    },
    { errors: 0, warnings: 0, info: 0 },
  )
  return { ...report, summary }
}

function addProjectFindings(
  report: ScanReport,
  snapshot: ProjectSnapshot,
  config: ResolvedConfig,
): ScanReport {
  const findings: Finding[] = [...report.findings]
  const add = (finding: Finding): void => {
    if (config.rules[finding.ruleId] !== "off") {
      findings.push({ ...finding, severity: config.rules[finding.ruleId] as "error" | "warning" | "info" })
    }
  }

  for (const deleted of snapshot.deletedPaths) {
    add({
      ruleId: "SUPA014",
      severity: "error",
      message: "A tracked Supabase SQL file was deleted; migration history must remain immutable after deployment.",
      file: deleted,
      line: 1,
      suggestion: "Restore the migration and add a new forward migration, or obtain a recorded approval if it was never deployed.",
    })
  }

  if (report.hasRlsChanges && snapshot.testFiles.length === 0) {
    add({
      ruleId: "SUPA017",
      severity: "warning",
      message: "RLS changed, but no pgTAP database tests were found in the configured test directories.",
      file: report.files[0] ?? "supabase/migrations",
      line: 1,
      suggestion: "Add positive and negative tests for each relevant role, including cross-tenant denial cases.",
    })
  }

  findings.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.ruleId.localeCompare(right.ruleId),
  )
  return recalculateSummary({ ...report, findings })
}

function applies(check: CheckConfig, snapshot: ProjectSnapshot): boolean {
  if (check.when === "always") return true
  if (check.when === "supabase-changed") return snapshot.supabaseChanged
  return snapshot.supabaseChanged && snapshot.testFiles.length > 0
}

function requiredCheckIds(config: ResolvedConfig, snapshot: ProjectSnapshot): string[] {
  const ids = config.checks.filter((check) => check.required && applies(check, snapshot)).map((check) => check.id)
  if (snapshot.supabaseChanged && config.generatedTypes && config.generatedTypes.required) ids.push("generated-types")
  return ids
}

function combinedOutput(result: CommandResult): string | undefined {
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
  return output || undefined
}

function normalizeGeneratedTypes(value: string): string {
  return value.replaceAll("\r\n", "\n").trimEnd()
}

export class SupashipEngine {
  readonly root: string
  readonly config: ResolvedConfig

  constructor(root: string, config: ResolvedConfig) {
    this.root = path.resolve(root)
    this.config = config
  }

  private async snapshotAndScan(scope: ScanScope): Promise<{ snapshot: ProjectSnapshot; scan: ScanReport }> {
    const snapshot = await createSnapshot(this.root, this.config, scope)
    const scan = addProjectFindings(scanSql(snapshot.sqlSources, this.config), snapshot, this.config)
    return { snapshot, scan }
  }

  private buildReport(snapshot: ProjectSnapshot, scan: ScanReport, evidence: EvidenceState): ShipReport {
    const staleEvidence = evidence.fingerprint !== snapshot.fingerprint
    const checks = staleEvidence ? [] : evidence.checks
    const passed = new Set(checks.filter((check) => check.status === "passed").map((check) => check.id))
    const missingEvidence = requiredCheckIds(this.config, snapshot).filter((id) => !passed.has(id))
    const approval = activeApproval(evidence, snapshot.fingerprint)
    const staticBlocked =
      scan.summary.errors > 0 || (this.config.guard.blockOnWarnings && scan.summary.warnings > 0)
    const evidenceBlocked =
      this.config.guard.requireFreshEvidence && snapshot.supabaseChanged && missingEvidence.length > 0
    const approved = Boolean(approval)

    return {
      ready: approved || (!staticBlocked && !evidenceBlocked),
      approved,
      scope: snapshot.scope,
      fingerprint: snapshot.fingerprint,
      baseRef: snapshot.baseRef,
      changedPaths: snapshot.changedPaths,
      scan,
      checks,
      missingEvidence,
      staleEvidence,
      approval,
    }
  }

  async inspect(scope: ScanScope = "changed"): Promise<ShipReport> {
    const { snapshot, scan } = await this.snapshotAndScan(scope)
    const evidence = await loadEvidence(snapshot.root, this.config.stateFile)
    return this.buildReport(snapshot, scan, evidence)
  }

  async verificationPlan(scope: ScanScope = "changed"): Promise<Array<CheckConfig | { id: "generated-types"; name: string; command: string }>> {
    const snapshot = await createSnapshot(this.root, this.config, scope)
    const checks: Array<CheckConfig | { id: "generated-types"; name: string; command: string }> = this.config.checks
      .filter((check) => applies(check, snapshot))
      .map((check) => ({ ...check, command: materializeCommand(check.command, this.config) }))
    if (snapshot.supabaseChanged && this.config.generatedTypes) {
      checks.push({
        id: "generated-types",
        name: `Compare generated types with ${this.config.generatedTypes.path}`,
        command: materializeCommand(this.config.generatedTypes.command, this.config),
      })
    }
    return checks
  }

  async verify(options: VerifyOptions = {}): Promise<ShipReport> {
    const { snapshot, scan } = await this.snapshotAndScan(options.scope ?? "changed")
    const results: CheckResult[] = []

    for (const check of this.config.checks) {
      const command = materializeCommand(check.command, this.config)
      if (!applies(check, snapshot)) {
        results.push({
          id: check.id,
          name: check.name,
          command,
          required: check.required,
          status: "skipped",
          durationMs: 0,
          message: `Not applicable for ${snapshot.scope} scope.`,
        })
        continue
      }

      options.onCheckStart?.({ ...check, command })
      const result = await runCommand(command, snapshot.root, {
        signal: options.signal,
        maxOutputChars: this.config.maxOutputChars,
      })
      results.push({
        id: check.id,
        name: check.name,
        command,
        required: check.required,
        status: result.exitCode === 0 ? "passed" : "failed",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        output: combinedOutput(result),
      })
    }

    if (snapshot.supabaseChanged && this.config.generatedTypes) {
      const generated = this.config.generatedTypes
      const command = materializeCommand(generated.command, this.config)
      options.onCheckStart?.({
        id: "generated-types",
        name: `Compare generated types with ${generated.path}`,
        command,
      })
      const result = await runCommand(command, snapshot.root, {
        signal: options.signal,
        maxOutputChars: this.config.maxOutputChars,
      })
      let status: CheckResult["status"] = result.exitCode === 0 ? "passed" : "failed"
      let message: string | undefined

      if (status === "passed") {
        const target = path.resolve(snapshot.root, generated.path)
        if (!existsSync(target)) {
          status = "failed"
          message = `${generated.path} does not exist.`
        } else {
          const current = await readFile(target, "utf8")
          if (normalizeGeneratedTypes(current) !== normalizeGeneratedTypes(result.stdout)) {
            status = "failed"
            message = `${generated.path} is stale. Run the supaship_sync_types tool.`
          }
        }
      }

      results.push({
        id: "generated-types",
        name: `Generated types match ${generated.path}`,
        command,
        required: generated.required,
        status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        output: status === "failed" ? combinedOutput(result) : undefined,
        message,
      })
    }

    const previous = await loadEvidence(snapshot.root, this.config.stateFile)
    const state: EvidenceState = {
      schemaVersion: 1,
      fingerprint: snapshot.fingerprint,
      verifiedAt: new Date().toISOString(),
      checks: results,
      approval: activeApproval(previous, snapshot.fingerprint),
    }
    await saveEvidence(snapshot.root, this.config.stateFile, state)
    return this.buildReport(snapshot, scan, state)
  }

  async syncTypes(signal?: AbortSignal): Promise<SyncTypesResult> {
    if (!this.config.generatedTypes) {
      throw new Error("No generated types file was detected. Configure generatedTypes.path first.")
    }
    const snapshot = await createSnapshot(this.root, this.config, "changed")
    const command = materializeCommand(this.config.generatedTypes.command, this.config)
    const result = await runCommand(command, snapshot.root, {
      signal,
      maxOutputChars: this.config.maxOutputChars,
    })
    if (result.exitCode !== 0) {
      throw new Error(`Supabase type generation failed.\n${combinedOutput(result) ?? "No output."}`)
    }
    const target = path.resolve(snapshot.root, this.config.generatedTypes.path)
    const current = existsSync(target) ? await readFile(target, "utf8") : ""
    const next = `${normalizeGeneratedTypes(result.stdout)}\n`
    const changed = normalizeGeneratedTypes(current) !== normalizeGeneratedTypes(next)
    if (changed) {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, next, "utf8")
    }
    return { path: this.config.generatedTypes.path, changed, command: result }
  }

  async approve(reason: string, minutes = this.config.guard.approvalMinutes): Promise<ShipReport> {
    if (!reason.trim()) throw new Error("A non-empty approval reason is required.")
    const { snapshot, scan } = await this.snapshotAndScan("changed")
    const previous = await loadEvidence(snapshot.root, this.config.stateFile)
    const state: EvidenceState = {
      ...(previous.fingerprint === snapshot.fingerprint ? previous : emptyEvidence()),
      schemaVersion: 1,
      fingerprint: snapshot.fingerprint,
      approval: makeApproval(snapshot.fingerprint, reason.trim(), minutes),
    }
    await saveEvidence(snapshot.root, this.config.stateFile, state)
    return this.buildReport(snapshot, scan, state)
  }
}
