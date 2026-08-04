import { spawn } from "node:child_process"
import type { CommandResult, ResolvedConfig } from "./types.js"

function trimOutput(value: string, maximum: number): string {
  if (value.length <= maximum) return value
  const side = Math.max(1, Math.floor((maximum - 80) / 2))
  return `${value.slice(0, side)}\n… ${value.length - side * 2} characters omitted …\n${value.slice(-side)}`
}

export function runCommand(
  command: string,
  cwd: string,
  options: { signal?: AbortSignal; maxOutputChars?: number } = {},
): Promise<CommandResult> {
  const started = Date.now()
  const maximum = options.maxOutputChars ?? 8_000

  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    })

    // Checks spawn their own children (supabase → docker); killing only the
    // shell would orphan them, so terminate the whole process group.
    const killTree = (): void => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM")
          return
        } catch {
          // The group is already gone; fall through to the direct kill.
        }
      }
      child.kill("SIGTERM")
    }
    if (options.signal?.aborted) killTree()
    else options.signal?.addEventListener("abort", killTree, { once: true })

    let stdout = ""
    let stderr = ""
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk
    })

    const finish = (result: CommandResult): void => {
      options.signal?.removeEventListener("abort", killTree)
      resolve(result)
    }

    child.on("error", (error) => {
      finish({
        command,
        exitCode: 1,
        stdout: trimOutput(stdout, maximum),
        stderr: trimOutput(`${stderr}${stderr ? "\n" : ""}${error.message}`, maximum),
        durationMs: Date.now() - started,
      })
    })
    child.on("close", (code) => {
      finish({
        command,
        exitCode: code ?? 1,
        stdout: trimOutput(stdout, maximum),
        stderr: trimOutput(stderr, maximum),
        durationMs: Date.now() - started,
      })
    })
  })
}

function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean)
}

export function isGuardedCommand(command: string, config: ResolvedConfig): boolean {
  if (config.guard.mode === "off") return false
  const patterns = config.guard.commands.map((pattern) => new RegExp(pattern, "i"))
  // --dry-run only exempts its own segment, so `git push --dry-run && git push`
  // stays guarded.
  return commandSegments(command).some(
    (segment) =>
      !/(?:^|\s)--dry-run(?:\s|$)/i.test(segment) &&
      patterns.some((pattern) => pattern.test(segment)),
  )
}
