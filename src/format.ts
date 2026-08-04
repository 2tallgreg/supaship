import type { ShipReport } from "./types.js"

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

  if (report.checks.length) {
    lines.push("", "Verification:")
    for (const check of report.checks) {
      lines.push(`  ${mark(check.status)} ${check.id} — ${check.name} (${duration(check.durationMs)})`)
      if (check.message) lines.push(`    ${check.message}`)
      if (check.status === "failed" && check.output) {
        const firstLine = check.output.split("\n").find(Boolean)
        if (firstLine) lines.push(`    ${firstLine}`)
      }
    }
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
