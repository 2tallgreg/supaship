import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Approval, EvidenceState } from "./types.js"

export function emptyEvidence(): EvidenceState {
  return { schemaVersion: 1, checks: [] }
}

export async function loadEvidence(root: string, relativePath: string): Promise<EvidenceState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.resolve(root, relativePath), "utf8"))
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "schemaVersion" in parsed &&
      parsed.schemaVersion === 1 &&
      "checks" in parsed &&
      Array.isArray(parsed.checks)
    ) {
      return parsed as EvidenceState
    }
  } catch {
    // Missing or invalid local evidence is treated as no evidence.
  }
  return emptyEvidence()
}

export async function saveEvidence(root: string, relativePath: string, state: EvidenceState): Promise<void> {
  const target = path.resolve(root, relativePath)
  const directory = path.dirname(target)
  const temporary = `${target}.${process.pid}.tmp`
  await mkdir(directory, { recursive: true })
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(temporary, target)
}

export function activeApproval(state: EvidenceState, fingerprint: string, now = new Date()): Approval | undefined {
  if (!state.approval || state.approval.fingerprint !== fingerprint) return undefined
  return new Date(state.approval.expiresAt).getTime() > now.getTime() ? state.approval : undefined
}

export function makeApproval(fingerprint: string, reason: string, minutes: number, now = new Date()): Approval {
  return {
    fingerprint,
    reason,
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + minutes * 60_000).toISOString(),
  }
}
