import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { ProjectSnapshot, ResolvedConfig, ScanScope, SqlSource } from "./types.js"

const execFileAsync = promisify(execFile)

function slash(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "")
}

function isWithin(relativePath: string, directory: string): boolean {
  const normalizedPath = slash(relativePath)
  const normalizedDirectory = slash(directory).replace(/\/$/, "")
  return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}/`)
}

async function runGit(root: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    })
    return result.stdout
  } catch {
    return undefined
  }
}

function parseNullSeparated(value: string | undefined): string[] {
  return value ? value.split("\0").map(slash).filter(Boolean) : []
}

async function walk(root: string, relativeDirectory: string, extension?: string): Promise<string[]> {
  const absolute = path.join(root, relativeDirectory)
  if (!existsSync(absolute)) return []
  const result: string[] = []

  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const item = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(item)
      else if (entry.isFile() && (!extension || entry.name.toLowerCase().endsWith(extension))) {
        result.push(slash(path.relative(root, item)))
      }
    }
  }

  await visit(absolute)
  return result.sort()
}

async function resolveBaseRef(root: string, configured?: string): Promise<string | undefined> {
  if (configured) {
    const exists = await runGit(root, ["rev-parse", "--verify", "--quiet", configured])
    if (!exists) throw new Error(`Supaship baseRef does not resolve: ${configured}`)
    return configured
  }

  const remoteHead = (await runGit(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]))?.trim()
  const current = (await runGit(root, ["branch", "--show-current"]))?.trim()
  const candidates = [remoteHead, "origin/main", "origin/master", "main", "master"].filter(
    (value): value is string => Boolean(value),
  )

  for (const candidate of [...new Set(candidates)]) {
    if (candidate === current) continue
    if (await runGit(root, ["rev-parse", "--verify", "--quiet", candidate])) return candidate
  }
  return undefined
}

async function discoverGitChanges(root: string, baseRef?: string): Promise<{ paths: string[]; deleted: string[] }> {
  const pathSet = new Set<string>()
  const deletedSet = new Set<string>()
  const add = (output: string | undefined): void => {
    for (const item of parseNullSeparated(output)) pathSet.add(item)
  }

  add(await runGit(root, ["diff", "--name-only", "--diff-filter=ACMRD", "-z"]))
  add(await runGit(root, ["diff", "--cached", "--name-only", "--diff-filter=ACMRD", "-z"]))
  add(await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
  if (baseRef) add(await runGit(root, ["diff", "--name-only", "--diff-filter=ACMRD", "-z", `${baseRef}...HEAD`]))

  for (const item of pathSet) {
    if (!existsSync(path.join(root, item))) deletedSet.add(item)
  }

  return { paths: [...pathSet].sort(), deleted: [...deletedSet].sort() }
}

async function readSources(root: string, paths: string[]): Promise<SqlSource[]> {
  return Promise.all(
    paths.map(async (relativePath) => ({
      path: relativePath,
      content: await readFile(path.join(root, relativePath), "utf8"),
    })),
  )
}

async function addFileToHash(hash: ReturnType<typeof createHash>, root: string, relativePath: string): Promise<void> {
  hash.update(`\0${slash(relativePath)}\0`)
  try {
    const file = await stat(path.join(root, relativePath))
    if (file.isFile()) hash.update(await readFile(path.join(root, relativePath)))
    else hash.update("NOT_A_FILE")
  } catch {
    hash.update("DELETED")
  }
}

export async function createSnapshot(
  root: string,
  config: ResolvedConfig,
  requestedScope: ScanScope,
): Promise<ProjectSnapshot> {
  const gitRoot = (await runGit(root, ["rev-parse", "--show-toplevel"]))?.trim()
  const actualRoot = gitRoot ? path.resolve(gitRoot) : path.resolve(root)
  const isGit = Boolean(gitRoot)
  const scope: ScanScope = !isGit && requestedScope === "changed" ? "all" : requestedScope
  const baseRef = isGit ? await resolveBaseRef(actualRoot, config.baseRef) : undefined
  const gitChanges = isGit ? await discoverGitChanges(actualRoot, baseRef) : { paths: [], deleted: [] }

  const allSqlPaths = (
    await Promise.all(config.sqlDirectories.map((directory) => walk(actualRoot, directory, ".sql")))
  ).flat()
  const sqlPaths =
    scope === "all"
      ? [...new Set(allSqlPaths)].sort()
      : gitChanges.paths.filter(
          (item) =>
            item.toLowerCase().endsWith(".sql") &&
            config.sqlDirectories.some((directory) => isWithin(item, directory)) &&
            existsSync(path.join(actualRoot, item)),
        )

  const testFiles = (
    await Promise.all(config.testDirectories.map((directory) => walk(actualRoot, directory, ".sql")))
  ).flat()
  const relevantDeleted = gitChanges.deleted.filter(
    (item) =>
      item.toLowerCase().endsWith(".sql") &&
      config.sqlDirectories.some((directory) => isWithin(item, directory)),
  )
  const supabaseChanged =
    scope === "all"
      ? sqlPaths.length > 0
      : gitChanges.paths.some((item) => isWithin(item, "supabase"))

  const hash = createHash("sha256")
  hash.update("supaship-fingerprint-v1\0")
  hash.update(JSON.stringify({
    scope,
    baseRef,
    exposedSchemas: config.exposedSchemas,
    rules: config.rules,
    checks: config.checks,
    generatedTypes: config.generatedTypes,
  }))

  const fingerprintPaths = new Set<string>([
    ...sqlPaths,
    ...relevantDeleted,
    ...testFiles,
    ...(scope === "changed" ? gitChanges.paths.filter((item) => isWithin(item, "supabase")) : []),
  ])
  if (existsSync(path.join(actualRoot, "supabase/config.toml"))) fingerprintPaths.add("supabase/config.toml")
  if (config.generatedTypes) fingerprintPaths.add(config.generatedTypes.path)
  for (const item of [...fingerprintPaths].sort()) await addFileToHash(hash, actualRoot, item)

  return {
    root: actualRoot,
    scope,
    baseRef,
    changedPaths: scope === "changed" ? gitChanges.paths : sqlPaths,
    deletedPaths: relevantDeleted,
    sqlSources: await readSources(actualRoot, sqlPaths),
    testFiles: [...new Set(testFiles)].sort(),
    supabaseChanged,
    fingerprint: hash.digest("hex"),
  }
}
