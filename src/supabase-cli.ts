import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { runCommand } from "./commands.js"
import type {
  CliCapabilities,
  CliEnvironment,
  PreflightCheck,
  PreflightStatus,
  ResolvedConfig,
} from "./types.js"

/**
 * Everything Supaship knows about driving the Supabase CLI: which binary to
 * call, whether the local stack can answer, which subcommands this version
 * understands, and how to turn a raw CLI failure into a next step.
 */

const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/

/** Cobra's phrasing when a subcommand or flag predates the installed CLI. */
const UNSUPPORTED_PATTERN = /unknown (?:command|flag|shorthand flag)\b/i

const INSTALL_HINT =
  "Install the Supabase CLI with `npm install supabase --save-dev` (then call it as `npx supabase`) or `brew install supabase/tap/supabase`."
const UPGRADE_HINT =
  "Upgrade the Supabase CLI with `npm install supabase@latest --save-dev` or `brew upgrade supabase`."

interface Diagnostic {
  match: RegExp
  remedy: string
}

// Ordered most specific first; the first match wins.
const DIAGNOSTICS: Diagnostic[] = [
  {
    match: /command not found|not recognized as an internal or external command|\bENOENT\b/i,
    remedy: INSTALL_HINT,
  },
  {
    match: UNSUPPORTED_PATTERN,
    remedy: `This Supabase CLI does not have that command or flag yet. ${UPGRADE_HINT}`,
  },
  {
    match: /cannot connect to the docker daemon|docker daemon is not running|is the docker daemon running|error during connect/i,
    remedy:
      "Start your container runtime (Docker Desktop, Rancher, Podman, or OrbStack) with at least 7 GB of RAM, then retry.",
  },
  {
    match: /have you run ['`"]?supabase start|supabase start is not running|local development stack .{0,40}not running|failed to connect to postgres|connection refused/i,
    remedy: "Start the local stack with `supabase start`, then retry.",
  },
  {
    match: /port \d+ is already in use|address already in use|bind: address already in use/i,
    remedy: "A Supabase port is already taken. Run `supabase stop`, free the port, then `supabase start`.",
  },
  {
    match: /missing config file|cannot read config|config\.toml.{0,40}no such file|no such file or directory.{0,40}config\.toml/i,
    remedy: "Run `supabase init` to create supabase/config.toml before running Supabase commands.",
  },
  {
    match: /access token not provided|have you run ['`"]?supabase login|not logged in/i,
    remedy: "Authenticate with `supabase login`.",
  },
  {
    match: /cannot find project ref|have you run ['`"]?supabase link|project not linked/i,
    remedy: "Link the project with `supabase link --project-ref <ref>`.",
  },
  {
    match: /remote migration versions not found in local migrations directory/i,
    remedy:
      "Remote history contains versions this repository does not. Compare with `supabase migration list --linked`, then reconcile with `supabase migration repair --status reverted <version>`.",
  },
  {
    match: /found local migration files to be inserted before the last migration/i,
    remedy:
      "A new migration sorts before one already applied remotely. Rename it with a later timestamp, or reconcile history with `supabase migration repair`.",
  },
  {
    match: /supabase_vector|health check failed|container .{0,40}unhealthy/i,
    remedy: "A local container failed its health check. Run `supabase stop` then `supabase start` to rebuild the stack.",
  },
  {
    match: /(?:syntax error at or near|error at line \d+|failed to (?:apply|run) migration)/i,
    remedy:
      "The migration failed to apply. Fix the SQL in the reported migration file, then run `supabase db reset` again.",
  },
]

/** Turns raw CLI output into a single actionable next step, when one is known. */
export function diagnose(output: string | undefined): string | undefined {
  if (!output) return undefined
  return DIAGNOSTICS.find((entry) => entry.match.test(output))?.remedy
}

/** True when a failure means "this CLI is too old", not "your schema is wrong". */
export function isUnsupportedByCli(output: string | undefined): boolean {
  return Boolean(output && UNSUPPORTED_PATTERN.test(output))
}

/**
 * Whether a command invokes the Supabase CLI. Checked against the template so
 * `{supabase}` counts, and against the resolved form so a literal `supabase`,
 * `npx supabase`, or `./node_modules/.bin/supabase` counts too.
 */
export function usesSupabaseCli(command: string): boolean {
  if (command.includes("{supabase}")) return true
  return /(?:^|[\s"'`/\\])supabase(?:\.cmd|\.exe)?(?=\s|$)/i.test(command)
}

/**
 * Supabase CLI commands that reach a remote database. `db push`, `db pull`, and
 * `db dump` default to `--linked`; the rest are local unless a remote target is
 * named. Read-only remote commands (`db lint --linked`, `db advisors --linked`,
 * `migration list --linked`) are deliberately absent — verification may read a
 * remote project, it may not write to one.
 */
const ALWAYS_REMOTE_WRITE =
  /\bsupabase\b[^\n]*?\b(?:db\s+push|migration\s+repair|config\s+push|secrets\s+(?:set|unset)|functions\s+(?:deploy|delete)|branches\s+(?:create|delete|update)|projects\s+(?:create|delete)|domains\s+(?:create|delete|activate)|network-restrictions\s+update|ssl-enforcement\s+update)\b/i

const REMOTE_WRITE_WITH_TARGET =
  /\bsupabase\b[^\n]*?\b(?:db\s+(?:reset|query)|migration\s+(?:up|down|squash))\b/i

const REMOTE_TARGET_FLAG = /(?:^|\s)--(?:linked|db-url|project-ref)\b/i

/** True when running this command would write to a linked or remote database. */
export function writesToRemoteDatabase(command: string): boolean {
  if (ALWAYS_REMOTE_WRITE.test(command)) return true
  return REMOTE_WRITE_WITH_TARGET.test(command) && REMOTE_TARGET_FLAG.test(command)
}

function parseVersion(output: string): string | undefined {
  return VERSION_PATTERN.exec(output)?.[1]
}

/**
 * Best-effort read of the project ref the CLI stores after `supabase link`.
 * Informational only — its absence never blocks anything.
 */
function readLinkedProjectRef(root: string): string | undefined {
  const file = path.join(root, "supabase", ".temp", "project-ref")
  if (!existsSync(file)) return undefined
  try {
    const value = readFileSync(file, "utf8").trim()
    return value || undefined
  } catch {
    return undefined
  }
}

async function probeCapabilities(
  supabaseCommand: string,
  root: string,
  signal?: AbortSignal,
): Promise<CliCapabilities> {
  const [advisors, lint, declarative] = await Promise.all([
    runCommand(`${supabaseCommand} db advisors --help`, root, { signal, maxOutputChars: 4_000 }),
    runCommand(`${supabaseCommand} db lint --help`, root, { signal, maxOutputChars: 4_000 }),
    runCommand(`${supabaseCommand} db schema declarative --help`, root, { signal, maxOutputChars: 4_000 }),
  ])
  const supports = (result: { exitCode: number; stdout: string; stderr: string }): boolean =>
    result.exitCode === 0 && !UNSUPPORTED_PATTERN.test(`${result.stdout}${result.stderr}`)

  return {
    advisors: supports(advisors),
    lintFailOn: /--fail-on/.test(`${lint.stdout}${lint.stderr}`),
    declarativeSchema: supports(declarative),
  }
}

const WORSE: Record<PreflightStatus, number> = { ok: 0, unknown: 1, warning: 2, blocked: 3 }

/**
 * Reads the local Supabase environment without touching a database.
 *
 * Runs only a fixed, read-only allowlist: `--version`, `status`, and `--help`.
 * With `probeCapabilities`, adds three more `--help` probes so callers can be
 * told about missing subcommands before a long `db reset` fails on one.
 */
export async function inspectCliEnvironment(
  root: string,
  config: ResolvedConfig,
  options: { signal?: AbortSignal; probeCapabilities?: boolean } = {},
): Promise<CliEnvironment> {
  const command = config.supabaseCommand
  const checks: PreflightCheck[] = []
  const linkedProjectRef = readLinkedProjectRef(root)

  const versionResult = await runCommand(`${command} --version`, root, {
    signal: options.signal,
    maxOutputChars: 2_000,
  })
  const combinedVersionOutput = `${versionResult.stdout}\n${versionResult.stderr}`
  const version = versionResult.exitCode === 0 ? parseVersion(combinedVersionOutput) : undefined

  if (versionResult.exitCode !== 0) {
    checks.push({
      id: "cli",
      status: "blocked",
      detail: `\`${command} --version\` failed.`,
      remedy: diagnose(combinedVersionOutput) ?? INSTALL_HINT,
    })
    return {
      command,
      capabilities: { advisors: false, lintFailOn: false, declarativeSchema: false },
      checks,
      linkedProjectRef,
      ready: false,
    }
  }

  checks.push({
    id: "cli",
    status: "ok",
    detail: `Supabase CLI ${version ?? combinedVersionOutput.trim().split("\n")[0] ?? "detected"} at \`${command}\`.`,
  })

  const configToml = path.join(root, "supabase", "config.toml")
  if (existsSync(configToml)) {
    checks.push({ id: "project", status: "ok", detail: "supabase/config.toml is present." })
  } else {
    checks.push({
      id: "project",
      status: "blocked",
      detail: "supabase/config.toml is missing, so the CLI has no project to act on.",
      remedy: "Run `supabase init` in the repository root.",
    })
  }

  const statusResult = await runCommand(`${command} status`, root, {
    signal: options.signal,
    maxOutputChars: config.maxOutputChars,
  })
  const statusOutput = `${statusResult.stdout}\n${statusResult.stderr}`
  if (statusResult.exitCode === 0) {
    checks.push({ id: "stack", status: "ok", detail: "The local Supabase stack is running." })
  } else {
    const remedy = diagnose(statusOutput)
    const dockerDown = /docker daemon|error during connect/i.test(statusOutput)
    checks.push({
      id: dockerDown ? "docker" : "stack",
      status: "blocked",
      detail: dockerDown
        ? "The container runtime is not reachable, so the local stack cannot start."
        : "The local Supabase stack is not running.",
      remedy: remedy ?? "Start the local stack with `supabase start`.",
    })
  }

  if (linkedProjectRef) {
    checks.push({
      id: "link",
      status: "warning",
      detail: `This project is linked to ${linkedProjectRef}; \`--linked\` and \`--db-url\` flags target production.`,
      remedy: "Keep verification commands on `--local`. Supaship refuses remote-writing checks unless allowRemoteWrites is set.",
    })
  }

  const capabilities = options.probeCapabilities
    ? await probeCapabilities(command, root, options.signal)
    : { advisors: false, lintFailOn: false, declarativeSchema: false }

  if (options.probeCapabilities) {
    if (!capabilities.advisors) {
      checks.push({
        id: "capabilities",
        status: "warning",
        detail: "This CLI has no `db advisors` command, so the advisor check cannot run.",
        remedy: UPGRADE_HINT,
      })
    }
    if (!capabilities.lintFailOn) {
      checks.push({
        id: "capabilities",
        status: "warning",
        detail: "This CLI's `db lint` has no `--fail-on` flag, so lint findings may not fail the check.",
        remedy: UPGRADE_HINT,
      })
    }
  }

  const worst = checks.reduce<PreflightStatus>(
    (current, check) => (WORSE[check.status] > WORSE[current] ? check.status : current),
    "ok",
  )

  return {
    command,
    version,
    capabilities,
    checks,
    linkedProjectRef,
    ready: worst !== "blocked",
  }
}

/** The blocking preflight problems, phrased for a report. */
export function blockingPreflight(environment: CliEnvironment): PreflightCheck[] {
  return environment.checks.filter((check) => check.status === "blocked")
}
