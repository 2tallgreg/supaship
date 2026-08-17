import type { Plugin, ToolContext, ToolResult } from "@opencode-ai/plugin"
import { z } from "zod"
import { isGuardedCommand } from "./commands.js"
import { loadConfig, materializeCommand } from "./config.js"
import { SupashipEngine } from "./engine.js"
import { formatCompactReport, formatEnvironmentReport, formatShipReport } from "./format.js"
import type { ScanScope } from "./types.js"

function defineTool<Args extends z.ZodRawShape>(input: {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<ToolResult>
}) {
  return input
}

export { loadConfig } from "./config.js"
export { SupashipEngine } from "./engine.js"
export { formatEnvironmentReport, formatShipReport } from "./format.js"
export { scanSql, RULE_DESCRIPTIONS } from "./sql-scanner.js"
export {
  diagnose,
  inspectCliEnvironment,
  usesSupabaseCli,
  writesToRemoteDatabase,
} from "./supabase-cli.js"
export type * from "./types.js"

export const Supaship: Plugin = async ({ client, directory, worktree }, options = {}) => {
  const root = worktree || directory
  const config = loadConfig(root, options)
  const engine = new SupashipEngine(root, config)

  const log = async (level: "info" | "warn" | "error", message: string): Promise<void> => {
    await client.app.log({
      body: {
        service: "supaship",
        level,
        message,
      },
    })
  }

  return {
    tool: {
      supaship_status: defineTool({
        description:
          "Inspect changed Supabase SQL, RLS safety, generated-type evidence, and verification status without modifying files or databases.",
        args: {
          scope: z.enum(["changed", "all"]).optional().describe("Scan changed SQL or every configured SQL file."),
          format: z.enum(["text", "json"]).optional().describe("Return a readable report or structured JSON."),
        },
        async execute(args, context) {
          const report = await engine.inspect((args.scope ?? "changed") as ScanScope)
          context.metadata({
            title: `Supaship ${report.ready ? "ready" : "blocked"}`,
            metadata: {
              ready: report.ready,
              approved: report.approved,
              errors: report.scan.summary.errors,
              warnings: report.scan.summary.warnings,
              fingerprint: report.fingerprint,
            },
          })
          return args.format === "json" ? JSON.stringify(report, null, 2) : formatShipReport(report)
        },
      }),

      supaship_doctor: defineTool({
        description:
          "Report the local Supabase CLI version, container stack state, linked project, and which CLI subcommands are available, with a fix for every problem found. Runs only read-only commands: supabase --version, supabase status, and --help probes.",
        args: {
          format: z.enum(["text", "json"]).optional().describe("Return a readable report or structured JSON."),
        },
        async execute(args, context) {
          const environment = await engine.doctor(context.abort)
          context.metadata({
            title: `Supabase CLI ${environment.ready ? "ready" : "not ready"}`,
            metadata: {
              ready: environment.ready,
              version: environment.version,
              linked: Boolean(environment.linkedProjectRef),
              advisors: environment.capabilities.advisors,
            },
          })
          return args.format === "json"
            ? JSON.stringify(environment, null, 2)
            : formatEnvironmentReport(environment)
        },
      }),

      supaship_verify: defineTool({
        description:
          "Run the configured local Supabase checks — migration drift, database rebuild, lint, security advisors, pgTAP, and generated types — then record fingerprinted shipping evidence.",
        args: {
          scope: z.enum(["changed", "all"]).optional().describe("Verify changed SQL or the full configured SQL set."),
        },
        async execute(args, context) {
          const scope = (args.scope ?? "changed") as ScanScope
          const plan = await engine.verificationPlan(scope)
          if (plan.length) {
            await context.ask({
              permission: "supaship.verify",
              patterns: plan.map((check) => check.command),
              always: [],
              metadata: {
                description: "Run Supaship's local verification commands",
                checks: plan.map((check) => check.id),
              },
            })
          }
          const report = await engine.verify({ scope, signal: context.abort })
          context.metadata({
            title: `Supaship verification ${report.ready ? "passed" : "blocked"}`,
            metadata: {
              ready: report.ready,
              errors: report.scan.summary.errors,
              warnings: report.scan.summary.warnings,
              missingEvidence: report.missingEvidence,
              fingerprint: report.fingerprint,
            },
          })
          return formatShipReport(report)
        },
      }),

      supaship_sync_types: defineTool({
        description:
          "Regenerate the configured Supabase TypeScript definitions from the local database and update the tracked types file.",
        args: {},
        async execute(_args, context) {
          if (!config.generatedTypes) {
            throw new Error("No generated types file was detected. Configure generatedTypes.path in supaship.config.json.")
          }
          const command = materializeCommand(config.generatedTypes.command, config)
          await context.ask({
            permission: "supaship.sync-types",
            patterns: [command, config.generatedTypes.path],
            always: [],
            metadata: {
              description: "Generate and write Supabase TypeScript definitions",
            },
          })
          const result = await engine.syncTypes(context.abort)
          context.metadata({
            title: result.changed ? "Supabase types updated" : "Supabase types already current",
            metadata: { path: result.path, changed: result.changed },
          })
          return result.changed
            ? `Updated ${result.path}. Run supaship_verify again to record fresh evidence.`
            : `${result.path} already matches the local database.`
        },
      }),

      supaship_approve: defineTool({
        description:
          "Request an explicit, reasoned, time-limited human override for the current Supaship fingerprint. This never approves future changes.",
        args: {
          reason: z.string().min(8).describe("Specific reason this exact fingerprint is safe to ship."),
          minutes: z.number().int().min(1).max(240).optional().describe("Override lifetime; defaults to project config."),
        },
        async execute(args, context) {
          const before = await engine.inspect("changed")
          await context.ask({
            permission: "supaship.approve",
            patterns: [before.fingerprint, args.reason],
            always: [],
            metadata: {
              description: "Approve a blocked Supabase change",
              fingerprint: before.fingerprint,
              expiresInMinutes: args.minutes ?? config.guard.approvalMinutes,
            },
          })
          const report = await engine.approve(args.reason, args.minutes, before.fingerprint)
          context.metadata({
            title: "Supaship override approved",
            metadata: {
              fingerprint: report.fingerprint,
              expiresAt: report.approval?.expiresAt,
            },
          })
          return formatShipReport(report)
        },
      }),
    },

    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return
      const command = typeof output.args?.command === "string" ? output.args.command : ""
      if (!command || !isGuardedCommand(command, config)) return

      const report = await engine.inspect("changed")
      if (report.ready) {
        await log("info", `Allowed guarded command for ${report.fingerprint.slice(0, 12)}.`)
        return
      }

      const message = `Supaship intercepted a shipping command.\n\n${formatShipReport(report)}`
      if (config.guard.mode === "warn") {
        await log("warn", message)
        return
      }
      throw new Error(message)
    },

    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(
        [
          "Supaship guards this repository's Supabase delivery. Before pushing migrations, creating or merging a PR, or claiming database work is complete, call supaship_status and obtain fresh supaship_verify evidence. Never bypass a Supaship block without the user's explicit supaship_approve confirmation.",
          "Supabase CLI rules in this repository: verify against the local stack only. `supabase db diff`, `db reset`, `db lint`, `db advisors`, and `migration up` are local unless you pass `--linked` or `--db-url`, while `db push`, `db pull`, and `db dump` target the linked project by default. Write schema changes as migration files and rebuild with `supabase db reset`; never hand-edit an already-applied migration. When a Supabase command fails, run supaship_doctor before retrying — it reports the CLI version, stack state, and the missing prerequisite.",
        ].join(" "),
      )
    },

    "experimental.session.compacting": async (_input, output) => {
      try {
        const report = await engine.inspect("changed")
        output.context.push(formatCompactReport(report))
      } catch (error) {
        await log("warn", `Unable to preserve Supaship status during compaction: ${String(error)}`)
      }
    },
  }
}

export default Supaship
