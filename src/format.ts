import type { CliEnvironment, ShipReport } from "./types.js"

const PREFLIGHT_MARK: Record<string, string> = { ok: "✓", warning: "!", blocked: "✗", unknown: "?" }

/** Renders the local Supabase CLI environment, remedies included. */
export function formatEnvironmentReport(environment: CliEnvironment): string {
  const lines = [
    `SUPABASE CLI: ${environment.ready ? "READY" : "NOT READY"}`,
    `Binary: ${environment.command}${environment.version ? ` (v${environment.version})` : ""}`,
  ]
  if (environment.linkedProjectRef) lines.push(`Linked project: ${environment.linkedProjectRef}`)

  lines.push("", "Environment:")
  for (const check of environment.checks) {
    lines.push(`  ${PREFLIGHT_MARK[check.status] ?? "?"} ${check.id} — ${check.detail}`)
    if (check.remedy) lines.push(`    Fix: ${check.remedy}`)
  }

  // Capabilities are probed against the installed binary; without one there is
  // nothing to report but the install step above.
  if (environment.version) {
    const { advisors, lintFailOn, declarativeSchema } = environment.capabilities
    lines.push(
      "",
      "Command support:",
      `  ${advisors ? "✓" : "✗"} supabase db advisors`,
      `  ${lintFailOn ? "✓" : "✗"} supabase db lint --fail-on`,
      `  ${declarativeSchema ? "✓" : "✗"} supabase db schema declarative`,
    )
  }
  return lines.join("\n")
}

function mark(status: "passed" | "failed" | "skipped"): string {
  if (status === "passed") return "✓"
  if (status === "failed") return "✗"
  return "–"
}

function duration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${milliseconds}ms`
  return `${(milliseconds / 1_000).toFixed(1)}s`
}

export function formatShipReport(report: ShipReport): string {
  const label = report.approved ? "APPROVED" : report.ready ? "READY" : "BLOCKED"
  const lines = [
    `SUPASHIP: ${label}`,
    `Scope: ${report.scope}${report.baseRef ? ` against ${report.baseRef}` : ""}`,
    `Fingerprint: ${report.fingerprint.slice(0, 12)}`,
    `Static analysis: ${report.scan.summary.errors} error(s), ${report.scan.summary.warnings} warning(s)`,
  ]

  if (!report.changedPaths.length) lines.push("Changes: no project changes detected")
  else lines.push(`Changes: ${report.changedPaths.length} file(s)`)

  const blocked = report.environment?.checks.filter((check) => check.status === "blocked") ?? []
  // A remedy printed once for the environment is not repeated on every check it
  // stopped; that turns one problem into a wall of identical advice.
  const alreadyAdvised = new Set<string>()
  if (blocked.length) {
    lines.push("", "Supabase CLI environment:")
    for (const check of blocked) {
      lines.push(`  ✗ ${check.id} — ${check.detail}`)
      if (check.remedy) {
        lines.push(`    Fix: ${check.remedy}`)
        alreadyAdvised.add(check.remedy)
      }
    }
  } else if (report.environment?.version) {
    lines.push(`Supabase CLI: v${report.environment.version}, local stack reachable`)
  }

  if (report.checks.length) {
    lines.push("", "Verification:")
    for (const check of report.checks) {
      lines.push(`  ${mark(check.status)} ${check.id} — ${check.name} (${duration(check.durationMs)})`)
      if (check.message) lines.push(`    ${check.message}`)
      if (check.status === "failed" && check.output) {
        const firstLine = check.output.split("\n").find(Boolean)
        if (firstLine) lines.push(`    ${firstLine}`)
      }
      if (check.remedy && !alreadyAdvised.has(check.remedy)) lines.push(`    Fix: ${check.remedy}`)
    }
  }

  if (report.unsupportedChecks.length) {
    lines.push(
      "",
      `Not run by this Supabase CLI: ${report.unsupportedChecks.join(", ")}. Upgrade the CLI to restore these checks.`,
    )
  }

  if (report.missingEvidence.length) {
    lines.push("", `Missing fresh evidence: ${report.missingEvidence.join(", ")}`)
  }

  if (report.scan.findings.length) {
    lines.push("", "Findings:")
    for (const finding of report.scan.findings) {
      lines.push(`  ${finding.severity.toUpperCase()} ${finding.ruleId} ${finding.file}:${finding.line} — ${finding.message}`)
      if (finding.suggestion) lines.push(`    Fix: ${finding.suggestion}`)
    }
  }

  if (report.approval) {
    lines.push(
      "",
      `Approval: ${report.approval.reason}`,
      `Expires: ${report.approval.expiresAt}`,
    )
  }

  if (!report.ready) {
    lines.push("", "Next: fix the findings, run supaship_verify, or request a reasoned supaship_approve override.")
  }
  return lines.join("\n")
}

export function formatCompactReport(report: ShipReport): string {
  const status = report.approved ? "approved" : report.ready ? "ready" : "blocked"
  const missing = report.missingEvidence.length ? ` Missing: ${report.missingEvidence.join(", ")}.` : ""
  return `Supaship is ${status} for fingerprint ${report.fingerprint.slice(0, 12)}: ${report.scan.summary.errors} error(s), ${report.scan.summary.warnings} warning(s).${missing}`
}
