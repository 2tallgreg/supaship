import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import Supaship from "../dist/index.js"

test("exports the five OpenCode tools and shipping hooks", async () => {
  const root = path.resolve(import.meta.dirname, "..")
  const hooks = await Supaship(
    {
      client: { app: { log: async () => ({}) } },
      project: {},
      directory: root,
      worktree: root,
      serverUrl: new URL("http://127.0.0.1:4096"),
      $: {},
      experimental_workspace: { register() {} },
    },
    {
      generatedTypes: false,
      checks: [],
      guard: { mode: "off" },
    },
  )

  assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), [
    "supaship_approve",
    "supaship_doctor",
    "supaship_status",
    "supaship_sync_types",
    "supaship_verify",
  ])
  assert.equal(typeof hooks["tool.execute.before"], "function")
  assert.equal(typeof hooks["experimental.chat.system.transform"], "function")
  assert.equal(typeof hooks["experimental.session.compacting"], "function")
})
