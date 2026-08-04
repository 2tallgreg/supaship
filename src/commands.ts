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
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    })

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

    child.on("error", (error) => {
      resolve({
        command,
        exitCode: 1,
        stdout: trimOutput(stdout, maximum),
        stderr: trimOutput(`${stderr}${stderr ? "\n" : ""}${error.message}`, maximum),
        durationMs: Date.now() - started,
      })
    })
    child.on("close", (code) => {
      resolve({
        command,
        exitCode: code ?? 1,
        stdout: trimOutput(stdout, maximum),
        stderr: trimOutput(stderr, maximum),
        durationMs: Date.now() - started,
      })
    })
  })
}

export function isGuardedCommand(command: string, config: ResolvedConfig): boolean {
  if (config.guard.mode === "off" || /(?:^|\s)--dry-run(?:\s|$)/i.test(command)) return false
  return config.guard.commands.some((pattern) => new RegExp(pattern, "i").test(command))
}
