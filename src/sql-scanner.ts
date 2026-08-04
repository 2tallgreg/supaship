import type {
  Finding,
  ResolvedConfig,
  RuleId,
  ScanReport,
  Severity,
  SqlSource,
} from "./types.js"

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)`
const QUALIFIED_IDENT = String.raw`${IDENT}(?:\s*\.\s*${IDENT})?`
const MANAGED_SCHEMAS = String.raw`(?:auth|storage|realtime|vault|extensions|graphql(?:_public)?|net|supabase_functions|supabase_migrations)`

interface Statement {
  text: string
  original: string
  source: SqlSource
  offset: number
  line: number
}

interface LocatedObject {
  name: string
  source: SqlSource
  offset: number
  line: number
}

interface FunctionRecord extends LocatedObject {
  statement: Statement
}

export const RULE_DESCRIPTIONS: Record<RuleId, string> = {
  SUPA001: "New exposed table does not enable RLS",
  SUPA002: "New exposed table has no explicit Data API access decision",
  SUPA003: "Migration disables RLS",
  SUPA004: "UPDATE/ALL policy has no explicit WITH CHECK",
  SUPA005: "Write policy is unconditionally open",
  SUPA006: "Policy uses deprecated auth.role() authorization",
  SUPA007: "Authorization relies on user-editable metadata",
  SUPA008: "Exposed view does not use security_invoker",
  SUPA009: "SECURITY DEFINER function is in an exposed schema",
  SUPA010: "SECURITY DEFINER function has an unsafe search_path",
  SUPA011: "SECURITY DEFINER function execution is not explicitly revoked",
  SUPA012: "SECURITY DEFINER helper has no caller identity check",
  SUPA013: "RLS auth function is evaluated per row",
  SUPA014: "Migration contains destructive DDL",
  SUPA015: "Migration changes a Supabase-managed schema object",
  SUPA016: "Broad privileges are granted to a public API role",
  SUPA017: "RLS changes have no database tests",
}

function lineAt(source: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1
  }
  return line
}

function stripCommentsPreservingOffsets(source: string): string {
  const chars = source.split("")
  let index = 0
  let state: "normal" | "single" | "double" | "dollar" | "line" | "block" = "normal"
  let dollarTag = ""
  let blockDepth = 0

  const blank = (position: number): void => {
    if (chars[position] !== "\n" && chars[position] !== "\r") chars[position] = " "
  }

  while (index < chars.length) {
    const current = chars[index] ?? ""
    const next = chars[index + 1] ?? ""

    if (state === "line") {
      if (current === "\n") state = "normal"
      else blank(index)
      index += 1
      continue
    }

    if (state === "block") {
      if (current === "/" && next === "*") {
        blank(index)
        blank(index + 1)
        blockDepth += 1
        index += 2
        continue
      }
      if (current === "*" && next === "/") {
        blank(index)
        blank(index + 1)
        blockDepth -= 1
        index += 2
        if (blockDepth === 0) state = "normal"
        continue
      }
      blank(index)
      index += 1
      continue
    }

    if (state === "single") {
      if (current === "'" && next === "'") {
        index += 2
        continue
      }
      if (current === "'") state = "normal"
      index += 1
      continue
    }

    if (state === "double") {
      if (current === '"' && next === '"') {
        index += 2
        continue
      }
      if (current === '"') state = "normal"
      index += 1
      continue
    }

    if (state === "dollar") {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length
        state = "normal"
      } else {
        index += 1
      }
      continue
    }

    if (current === "-" && next === "-") {
      blank(index)
      blank(index + 1)
      state = "line"
      index += 2
      continue
    }
    if (current === "/" && next === "*") {
      blank(index)
      blank(index + 1)
      state = "block"
      blockDepth = 1
      index += 2
      continue
    }
    if (current === "'") {
      state = "single"
      index += 1
      continue
    }
    if (current === '"') {
      state = "double"
      index += 1
      continue
    }
    if (current === "$") {
      const match = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)
      if (match?.[0]) {
        dollarTag = match[0]
        state = "dollar"
        index += dollarTag.length
        continue
      }
    }
    index += 1
  }

  return chars.join("")
}

function splitStatements(source: SqlSource): Statement[] {
  const text = stripCommentsPreservingOffsets(source.content)
  const statements: Statement[] = []
  let start = 0
  let index = 0
  let state: "normal" | "single" | "double" | "dollar" = "normal"
  let dollarTag = ""

  const push = (end: number): void => {
    const statementText = text.slice(start, end)
    if (statementText.trim()) {
      const leading = statementText.search(/\S/)
      const offset = start + Math.max(0, leading)
      statements.push({
        text: statementText,
        original: source.content.slice(start, end),
        source,
        offset: start,
        line: lineAt(source.content, offset),
      })
    }
    start = end
  }

  while (index < text.length) {
    const current = text[index] ?? ""
    const next = text[index + 1] ?? ""

    if (state === "single") {
      if (current === "'" && next === "'") index += 2
      else {
        if (current === "'") state = "normal"
        index += 1
      }
      continue
    }
    if (state === "double") {
      if (current === '"' && next === '"') index += 2
      else {
        if (current === '"') state = "normal"
        index += 1
      }
      continue
    }
    if (state === "dollar") {
      if (text.startsWith(dollarTag, index)) {
        index += dollarTag.length
        state = "normal"
      } else index += 1
      continue
    }

    if (current === "'") {
      state = "single"
      index += 1
      continue
    }
    if (current === '"') {
      state = "double"
      index += 1
      continue
    }
    if (current === "$") {
      const match = text.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)
      if (match?.[0]) {
        dollarTag = match[0]
        state = "dollar"
        index += dollarTag.length
        continue
      }
    }
    if (current === ";") push(index + 1)
    index += 1
  }
  push(text.length)
  return statements
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1).replaceAll('""', '"').toLowerCase()
    : trimmed.toLowerCase()
}

function normalizeObjectName(value: string, defaultSchema = "public"): string {
  const parts = value.split(/\s*\.\s*/)
  if (parts.length === 1) return `${defaultSchema.toLowerCase()}.${unquoteIdentifier(parts[0] ?? "")}`
  return `${unquoteIdentifier(parts[0] ?? defaultSchema)}.${unquoteIdentifier(parts[1] ?? "")}`
}

function objectSchema(value: string): string {
  return value.split(".")[0] ?? "public"
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function identifierPattern(name: string): string {
  return `(?:"${escapeRegex(name)}"|\\b${escapeRegex(name)}\\b)`
}

function hasObjectReference(statement: string, objectName: string, defaultSchema = "public"): boolean {
  const [schema, name] = objectName.split(".")
  if (!schema || !name) return false
  const qualified = new RegExp(`${identifierPattern(schema)}\\s*\\.\\s*${identifierPattern(name)}`, "i")
  if (qualified.test(statement)) return true
  // An unqualified reference resolves to the default schema, so
  // `revoke all on notes ...` covers public.notes.
  if (schema !== defaultSchema) return false
  const bare = new RegExp(`(?:^|[^.\\w"])${identifierPattern(name)}(?![.\\w])`, "i")
  return bare.test(statement)
}

function statementObject(statement: string, kind: string): { raw: string; index: number } | undefined {
  const expression = new RegExp(
    String.raw`^\s*${kind}\s+(?:if\s+(?:not\s+)?exists\s+)?(${QUALIFIED_IDENT})`,
    "i",
  )
  const match = expression.exec(statement)
  if (!match?.[1]) return undefined
  return { raw: match[1], index: match.index + match[0].lastIndexOf(match[1]) }
}

function hasUnwrappedAuthFunction(statement: string): number | undefined {
  const expression = /\bauth\.(?:uid|jwt)\s*\(\s*\)/gi
  for (const match of statement.matchAll(expression)) {
    const index = match.index ?? 0
    const prefix = statement.slice(Math.max(0, index - 40), index)
    if (!/\(\s*select\s*$/i.test(prefix)) return index
  }
  return undefined
}

function severityFor(config: ResolvedConfig, ruleId: RuleId): Severity | undefined {
  const level = config.rules[ruleId]
  return level === "off" ? undefined : level
}

export function scanSql(sources: SqlSource[], config: ResolvedConfig): ScanReport {
  const statements = sources.flatMap(splitStatements)
  const findings: Finding[] = []
  const createdTables = new Map<string, LocatedObject>()
  const rlsEnabled = new Set<string>()
  const materializedViews: LocatedObject[] = []
  const functions: FunctionRecord[] = []
  let hasRlsChange = false

  const add = (
    ruleId: RuleId,
    statement: Statement | LocatedObject,
    message: string,
    options: { offset?: number; object?: string; suggestion?: string } = {},
  ): void => {
    const severity = severityFor(config, ruleId)
    if (!severity) return
    const absoluteOffset =
      "text" in statement
        ? statement.offset + (options.offset ?? Math.max(0, statement.text.search(/\S/)))
        : statement.offset + (options.offset ?? 0)
    findings.push({
      ruleId,
      severity,
      message,
      file: statement.source.path,
      line: lineAt(statement.source.content, absoluteOffset),
      object: options.object,
      suggestion: options.suggestion,
    })
  }

  for (const statement of statements) {
    const text = statement.text
    const createTable = statementObject(text, String.raw`create\s+(?:unlogged\s+)?table`)
    if (createTable) {
      const name = normalizeObjectName(createTable.raw)
      createdTables.set(name, {
        name,
        source: statement.source,
        offset: statement.offset + createTable.index,
        line: lineAt(statement.source.content, statement.offset + createTable.index),
      })
    }

    const enableRls = new RegExp(
      String.raw`^\s*alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(${QUALIFIED_IDENT})\s+enable\s+row\s+level\s+security`,
      "i",
    ).exec(text)
    if (enableRls?.[1]) {
      rlsEnabled.add(normalizeObjectName(enableRls[1]))
      hasRlsChange = true
    }

    const disableRls = new RegExp(
      String.raw`^\s*alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(${QUALIFIED_IDENT})\s+disable\s+row\s+level\s+security`,
      "i",
    ).exec(text)
    if (disableRls?.[1]) {
      const name = normalizeObjectName(disableRls[1])
      hasRlsChange = true
      add("SUPA003", statement, `RLS is disabled for ${name}.`, {
        offset: disableRls.index,
        object: name,
        suggestion: `Keep RLS enabled and change policies instead: ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY.`,
      })
    }

    const createPolicy = /^\s*create\s+policy\b/i.test(text)
    if (createPolicy) {
      hasRlsChange = true
      const target = new RegExp(String.raw`\bon\s+(?:table\s+)?(${QUALIFIED_IDENT})`, "i").exec(text)
      const object = target?.[1] ? normalizeObjectName(target[1]) : undefined
      const operation = /\bfor\s+(all|select|insert|update|delete)\b/i.exec(text)?.[1]?.toLowerCase() ?? "all"
      const hasWithCheck = /\bwith\s+check\s*\(/i.test(text)
      const openUsing = /\busing\s*\(\s*true\s*\)/i.test(text)
      const openCheck = /\bwith\s+check\s*\(\s*true\s*\)/i.test(text)

      if ((operation === "update" || operation === "all") && !hasWithCheck) {
        add("SUPA004", statement, `${operation.toUpperCase()} policy${object ? ` on ${object}` : ""} has no explicit WITH CHECK expression.`, {
          object,
          suggestion: "Add WITH CHECK with the same ownership or authorization constraint used for new row values.",
        })
      }

      // Postgres reuses USING for WITH CHECK when the latter is omitted, so
      // only a literally-open expression makes a write policy unconditional.
      const unconditionallyOpen =
        operation === "insert"
          ? openCheck
          : operation === "delete"
            ? openUsing
            : operation === "update" || operation === "all"
              ? openUsing || openCheck
              : false
      if (unconditionallyOpen) {
        add("SUPA005", statement, `${operation.toUpperCase()} policy${object ? ` on ${object}` : ""} permits writes without a row-level constraint.`, {
          object,
          suggestion: "Constrain USING and WITH CHECK with ownership, membership, or another explicit authorization predicate.",
        })
      }

      if (/\bauth\.role\s*\(/i.test(text)) {
        add("SUPA006", statement, `Policy${object ? ` on ${object}` : ""} uses deprecated auth.role().`, {
          object,
          suggestion: "Use a TO anon/authenticated clause and a separate row-level authorization predicate.",
        })
      }

      if (/\braw_user_meta_data\b/i.test(text) || /\bauth\.jwt\s*\(\s*\)[\s\S]{0,300}\buser_metadata\b/i.test(text)) {
        add("SUPA007", statement, `Policy${object ? ` on ${object}` : ""} relies on user-editable metadata.`, {
          object,
          suggestion: "Store authorization claims in app_metadata or in protected database tables.",
        })
      }

      const authFunctionOffset = hasUnwrappedAuthFunction(text)
      if (authFunctionOffset !== undefined) {
        add("SUPA013", statement, `Policy${object ? ` on ${object}` : ""} calls an auth function per row.`, {
          offset: authFunctionOffset,
          object,
          suggestion: "Wrap stable auth calls as (SELECT auth.uid()) or (SELECT auth.jwt()) so Postgres can cache the result.",
        })
      }
    }

    const createView = statementObject(text, String.raw`create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view`)
    if (createView) {
      const name = normalizeObjectName(createView.raw)
      if (config.exposedSchemas.includes(objectSchema(name))) {
        if (/^\s*create\s+(?:or\s+replace\s+)?materialized\b/i.test(text)) {
          materializedViews.push({
            name,
            source: statement.source,
            offset: statement.offset + createView.index,
            line: lineAt(statement.source.content, statement.offset + createView.index),
          })
        } else if (!/\bsecurity_invoker\s*=\s*(?:true|on)\b/i.test(text)) {
          add("SUPA008", statement, `Exposed view ${name} does not declare security_invoker = true.`, {
            offset: createView.index,
            object: name,
            suggestion: "Create the view WITH (security_invoker = true), or keep it in an unexposed schema with explicit grants.",
          })
        }
      }
    }

    const createFunction = statementObject(text, String.raw`create\s+(?:or\s+replace\s+)?function`)
    if (createFunction && /\bsecurity\s+definer\b/i.test(text)) {
      const name = normalizeObjectName(createFunction.raw)
      const record: FunctionRecord = {
        name,
        source: statement.source,
        offset: statement.offset + createFunction.index,
        line: lineAt(statement.source.content, statement.offset + createFunction.index),
        statement,
      }
      functions.push(record)

      if (config.exposedSchemas.includes(objectSchema(name))) {
        add("SUPA009", statement, `SECURITY DEFINER function ${name} is in an exposed schema.`, {
          offset: createFunction.index,
          object: name,
          suggestion: "Move privileged helpers to a private schema and grant only the minimum required access.",
        })
      }

      const searchPath = /\bset\s+search_path\s*(?:=|to)\s*([\s\S]*?)(?=\s+(?:as|language|security|cost|rows|support|parallel)\b|$)/i.exec(text)?.[1]
      if (!searchPath || /(?:^|,)\s*(?:public|"public"|\$user)\s*(?:,|$)/i.test(searchPath.trim())) {
        add("SUPA010", statement, `SECURITY DEFINER function ${name} has no locked-down search_path.`, {
          offset: createFunction.index,
          object: name,
          suggestion: "Declare SET search_path = '' and schema-qualify every referenced object.",
        })
      }

      if (!/\bauth\.uid\s*\(\s*\)/i.test(text)) {
        add("SUPA012", statement, `SECURITY DEFINER function ${name} has no explicit caller identity check.`, {
          offset: createFunction.index,
          object: name,
          suggestion: "If users can reach this helper, verify (SELECT auth.uid()) inside the function; otherwise document and restrict its caller.",
        })
      }
    }

    const destructive =
      /^\s*drop\s+(?:table|schema)\b/i.test(text) ||
      /^\s*truncate\b/i.test(text) ||
      /^\s*alter\s+table\b[\s\S]*?\bdrop\s+column\b/i.test(text) ||
      /^\s*alter\s+table\b[\s\S]*?\balter\s+column\b[\s\S]*?\btype\b/i.test(text)
    if (destructive) {
      add("SUPA014", statement, "Migration contains DDL that can discard data or make a rollback unsafe.", {
        suggestion: "Use an expand/migrate/contract rollout, or obtain a recorded Supaship approval for this fingerprint.",
      })
    }

    const managedObject = new RegExp(
      String.raw`^\s*(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:table|view|function|schema)\s+(?:if\s+(?:not\s+)?exists\s+)?(${MANAGED_SCHEMAS}\s*\.\s*${IDENT}|${MANAGED_SCHEMAS}\b)`,
      "i",
    ).exec(text)
    if (managedObject?.[1]) {
      const raw = managedObject[1]
      add("SUPA015", statement, `Migration changes Supabase-managed object ${raw.replaceAll(/\s+/g, "")}.`, {
        offset: managedObject.index,
        object: raw.replaceAll(/\s+/g, "").toLowerCase(),
        suggestion: "Prefer supported policies, triggers, config, or Supabase CLI workflows instead of changing managed objects.",
      })
    }

    const broadGrant = /^\s*grant\s+all(?:\s+privileges)?\s+on\b[\s\S]*?\bto\s+([^;]+)/i.exec(text)
    if (broadGrant?.[1] && /\b(?:anon|authenticated|public)\b/i.test(broadGrant[1])) {
      add("SUPA016", statement, "Migration grants ALL privileges to a public Data API role.", {
        suggestion: "Grant only the exact SELECT, INSERT, UPDATE, DELETE, USAGE, or EXECUTE privileges the role needs.",
      })
    }
  }

  const grantRevokeStatements = statements.filter((statement) => /^\s*(?:grant|revoke)\b/i.test(statement.text))
  const hasAccessDecision = (objectName: string): boolean =>
    grantRevokeStatements.some((statement) => hasObjectReference(statement.text, objectName))

  for (const table of createdTables.values()) {
    if (!config.exposedSchemas.includes(objectSchema(table.name))) continue
    if (!rlsEnabled.has(table.name)) {
      add("SUPA001", table, `New exposed table ${table.name} does not enable Row Level Security.`, {
        object: table.name,
        suggestion: `Add ALTER TABLE ${table.name} ENABLE ROW LEVEL SECURITY in the same migration.`,
      })
    }
    if (!hasAccessDecision(table.name)) {
      add("SUPA002", table, `New exposed table ${table.name} has no explicit GRANT or REVOKE decision.`, {
        object: table.name,
        suggestion: "Grant only the Data API privileges the table needs, or explicitly revoke access from anon and authenticated.",
      })
    }
  }

  for (const view of materializedViews) {
    if (hasAccessDecision(view.name)) continue
    add("SUPA008", view, `Exposed materialized view ${view.name} is served by the Data API without row security.`, {
      object: view.name,
      suggestion: "Materialized views cannot use security_invoker: move it to a private schema, or revoke SELECT from anon and authenticated and expose a controlled view instead.",
    })
  }

  for (const fn of functions) {
    const hasRevoke = statements.some(
      (statement) =>
        /^\s*revoke\s+execute\s+on\s+function\b/i.test(statement.text) &&
        hasObjectReference(statement.text, fn.name) &&
        /\bfrom\s+[\s\S]*\bpublic\b/i.test(statement.text),
    )
    if (!hasRevoke) {
      add("SUPA011", fn, `SECURITY DEFINER function ${fn.name} does not revoke EXECUTE from PUBLIC.`, {
        object: fn.name,
        suggestion: `REVOKE EXECUTE ON FUNCTION ${fn.name}(...) FROM PUBLIC, anon, authenticated, service_role; then grant only intended callers.`,
      })
    }
  }

  findings.sort((left, right) =>
    left.file.localeCompare(right.file) || left.line - right.line || left.ruleId.localeCompare(right.ruleId),
  )

  const summary = findings.reduce(
    (counts, finding) => {
      if (finding.severity === "error") counts.errors += 1
      else if (finding.severity === "warning") counts.warnings += 1
      else counts.info += 1
      return counts
    },
    { errors: 0, warnings: 0, info: 0 },
  )

  return {
    findings,
    files: sources.map((source) => source.path),
    createdTables: [...createdTables.keys()].sort(),
    hasRlsChanges: hasRlsChange,
    summary,
  }
}
