import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { materializeCommand } from "./config.js"
import { runCommand } from "./commands.js"
import { activeApproval, emptyEvidence, loadEvidence, makeApproval, saveEvidence } from "./evidence.js"
import { createSnapshot } from "./project.js"
import { scanSql } from "./sql-scanner.js"
import { blockingPreflight, diagnose, inspectCliEnvironment, isUnsupportedByCli, usesSupabaseCli } from "./supabase-cli.js"
import type {
  CheckConfig,
  CheckExpectation,
  CheckResult,
  CliEnvironment,
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
  onCheckStart?: (check: { id: string; name: string; command: string }) => void
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

/**
 * Some Supabase CLI commands report by output rather than exit code: `db diff`
 * prints a schema delta and still exits 0. Returns the failure message when an
 * expectation is violated.
 */
function violatedExpectation(
  expectation: CheckExpectation | undefined,
  result: CommandResult,
): string | undefined {
  if (!expectation) return undefined
  if (expectation.stdoutMustBeEmpty && result.stdout.trim()) {
    return expectation.message ?? "The command wrote output where none was expected."
  }
  if (expectation.stdoutMustNotMatch && new RegExp(expectation.stdoutMustNotMatch, "im").test(result.stdout)) {
    return expectation.message ?? `Standard output matched ${expectation.stdoutMustNotMatch}.`
  }
  const combined = `${result.stdout}\n${result.stderr}`
  if (expectation.outputMustNotMatch && new RegExp(expectation.outputMustNotMatch, "im").test(combined)) {
    return expectation.message ?? `Command output matched ${expectation.outputMustNotMatch}.`
  }
  return undefined
}

/** A required check the CLI cannot run is recorded, not silently dropped. */
function isUnsupported(check: CheckResult): boolean {
  return check.status === "skipped" && check.skipReason === "unsupported"
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
    // A check the installed CLI cannot run counts as satisfied — blocking on it
    // would be unfixable without an upgrade — but it is named in the report.
    const satisfied = new Set(
      checks.filter((check) => check.status === "passed" || isUnsupported(check)).map((check) => check.id),
    )
    const required = requiredCheckIds(this.config, snapshot)
    const missingEvidence = required.filter((id) => !satisfied.has(id))
    const unsupportedChecks = checks.filter((check) => isUnsupported(check) && required.includes(check.id)).map((check) => check.id)
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
      unsupportedChecks,
      staleEvidence,
      approval,
      environment: staleEvidence ? undefined : evidence.environment,
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

  /**
   * Reads the local Supabase CLI and stack without touching a database. Runs a
   * fixed read-only allowlist: `--version`, `status`, and `--help` probes.
   */
  async doctor(signal?: AbortSignal): Promise<CliEnvironment> {
    // A diagnostic must survive the problems it diagnoses, including an
    // unresolvable baseRef, so snapshot failure falls back to the given root.
    let root = this.root
    try {
      root = (await createSnapshot(this.root, this.config, "changed")).root
    } catch {
      // Keep this.root.
    }
    return inspectCliEnvironment(root, this.config, { signal, probeCapabilities: true })
  }

  async verify(options: VerifyOptions = {}): Promise<ShipReport> {
    const { snapshot, scan } = await this.snapshotAndScan(options.scope ?? "changed")
    const results: CheckResult[] = []
    const applicable = this.config.checks.filter((check) => applies(check, snapshot))
    const generated = snapshot.supabaseChanged ? this.config.generatedTypes : false

    // Reading the environment once costs two inert commands and turns a
    // six-minute `db reset` timeout into an immediate "start Docker".
    const needsCli =
      applicable.some((check) => usesSupabaseCli(check.command)) ||
      (generated ? usesSupabaseCli(generated.command) : false)
    const environment =
      this.config.preflight && needsCli
        ? await inspectCliEnvironment(snapshot.root, this.config, { signal: options.signal })
        : undefined
    const blockers = environment ? blockingPreflight(environment) : []

    const run = async (
      descriptor: {
        id: string
        name: string
        command: string
        required: boolean
        expect?: CheckExpectation
        /** Set for commands whose successful output is the artifact itself. */
        quietOnSuccess?: boolean
      },
    ): Promise<{ result: CheckResult; command: CommandResult | undefined }> => {
      const { id, name, command, required } = descriptor

      const blocker = blockers[0]
      if (blocker && usesSupabaseCli(command)) {
        return {
          result: {
            id,
            name,
            command,
            required,
            status: "failed",
            durationMs: 0,
            message: `Not run: ${blocker.detail}`,
            remedy: blocker.remedy,
          },
          command: undefined,
        }
      }

      options.onCheckStart?.({ id, name, command })
      const result = await runCommand(command, snapshot.root, {
        signal: options.signal,
        maxOutputChars: this.config.maxOutputChars,
      })
      const output = combinedOutput(result)

      if (result.exitCode !== 0 && isUnsupportedByCli(output)) {
        return {
          result: {
            id,
            name,
            command,
            required,
            status: "skipped",
            skipReason: "unsupported",
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            message: "The installed Supabase CLI does not support this command.",
            remedy: diagnose(output),
          },
          command: result,
        }
      }

      const violation = result.exitCode === 0 ? violatedExpectation(descriptor.expect, result) : undefined
      const failed = result.exitCode !== 0 || Boolean(violation)
      return {
        result: {
          id,
          name,
          command,
          required,
          status: failed ? "failed" : "passed",
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          // Advisor and lint warnings below the failure threshold only survive
          // if a passing check keeps its output.
          output: failed || !descriptor.quietOnSuccess ? output : undefined,
          message: violation,
          remedy: failed ? diagnose(output) : undefined,
        },
        command: result,
      }
    }

    for (const check of this.config.checks) {
      const command = materializeCommand(check.command, this.config)
      if (!applies(check, snapshot)) {
        results.push({
          id: check.id,
          name: check.name,
          command,
          required: check.required,
          status: "skipped",
          skipReason: "not-applicable",
          durationMs: 0,
          message: `Not applicable for ${snapshot.scope} scope.`,
        })
        continue
      }
      results.push((await run({ ...check, command })).result)
    }

    if (generated) {
      const command = materializeCommand(generated.command, this.config)
      const { result, command: raw } = await run({
        id: "generated-types",
        name: `Generated types match ${generated.path}`,
        command,
        required: generated.required,
        // A successful run prints the whole types file; storing it is noise.
        quietOnSuccess: true,
      })

      if (result.status === "passed" && raw) {
        const target = path.resolve(snapshot.root, generated.path)
        if (!existsSync(target)) {
          result.status = "failed"
          result.message = `${generated.path} does not exist.`
        } else {
          const current = await readFile(target, "utf8")
          if (normalizeGeneratedTypes(current) !== normalizeGeneratedTypes(raw.stdout)) {
            result.status = "failed"
            result.message = `${generated.path} is stale.`
            result.remedy = "Run the supaship_sync_types tool, or `supabase gen types typescript --local > " + generated.path + "`."
          }
        }
      }
      results.push(result)
    }

    const previous = await loadEvidence(snapshot.root, this.config.stateFile)
    const state: EvidenceState = {
      schemaVersion: 1,
      fingerprint: snapshot.fingerprint,
      verifiedAt: new Date().toISOString(),
      checks: results,
      approval: activeApproval(previous, snapshot.fingerprint),
      environment,
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

  async approve(
    reason: string,
    minutes = this.config.guard.approvalMinutes,
    expectedFingerprint?: string,
  ): Promise<ShipReport> {
    if (!reason.trim()) throw new Error("A non-empty approval reason is required.")
    const { snapshot, scan } = await this.snapshotAndScan("changed")
    if (expectedFingerprint && expectedFingerprint !== snapshot.fingerprint) {
      throw new Error(
        `The project changed while approval was pending: fingerprint is now ${snapshot.fingerprint.slice(0, 12)}, not ${expectedFingerprint.slice(0, 12)}. Review the current state and approve again.`,
      )
    }
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
