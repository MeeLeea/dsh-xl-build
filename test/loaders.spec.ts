/**
 * Loader behavior: schema-version gatekeeping, YAML/JSON equivalence, and the
 * Python compile path (self-skipping when no Python 3 interpreter is installed).
 */
import { spawnSync } from 'node:child_process'
import type { SpawnSyncReturns } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dump as dumpYaml } from 'js-yaml'
import { expect, test } from 'vitest'
import { loadPythonWorkflowFile, loadWorkflowFile, parseWorkflowText } from '../src/host/workflow/loaders.ts'

const FIXTURE = resolve("test/fixtures/py-chain.py")

const BASE_DOCUMENT = {
  schemaVersion: 1,
  id: "release",
  name: "Release",
  entry: "start",
  nodes: [
    { id: "start", kind: "input" },
    { id: "done", kind: "output", value: "{{nodes.start}}" },
  ],
  edges: [
    { id: "start-to-done", from: "start", to: "done", kind: "flow", format: "text" },
  ],
}

test("reports a missing schemaVersion with the expected version", () => {
  const raw = JSON.parse(JSON.stringify(BASE_DOCUMENT)) as { schemaVersion?: number }
  delete raw.schemaVersion
  expect(() => parseWorkflowText(JSON.stringify(raw), "release.json"))
    .toThrowError(/missing schemaVersion/)
})

test("rejects a newer schemaVersion with an upgrade pointer", () => {
  expect(() => parseWorkflowText(JSON.stringify({ ...BASE_DOCUMENT, schemaVersion: 2 }), "release.json"))
    .toThrowError(/schemaVersion 2 is newer than this plugin supports/)
})

test("rejects malformed schemaVersion values", () => {
  for (const version of [0, "1", 1.5, null]) {
    expect(() => parseWorkflowText(JSON.stringify({ ...BASE_DOCUMENT, schemaVersion: version }), "release.json"))
      .toThrowError(/schemaVersion must be a positive integer/)
  }
})

test("parses YAML and JSON spellings of one document to the same result", () => {
  const yamlDocument = parseWorkflowText(dumpYaml(BASE_DOCUMENT), "release.yaml")
  const jsonDocument = parseWorkflowText(JSON.stringify(BASE_DOCUMENT), "release.json")
  expect(yamlDocument).toEqual(jsonDocument)
})

test("reports a missing python interpreter across every candidate", () => {
  expect(() => loadPythonWorkflowFile(FIXTURE, {
    pythonCandidates: ["xl-build-absent-python", "xl-build-absent-python-2"],
  })).toThrowError(/no python interpreter found [(]tried: xl-build-absent-python, xl-build-absent-python-2[)]/)
})

test("reports a compile timeout with the configured budget", () => {
  function timedOutSpawn(_command: string, _args: readonly string[]): SpawnSyncReturns<string> {
    return {
      pid: -1,
      output: [null, null, null],
      stdout: "",
      stderr: "",
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("spawn ETIMEDOUT"), { code: "ETIMEDOUT" }),
    }
  }
  expect(() => loadPythonWorkflowFile(FIXTURE, { spawn: timedOutSpawn, pythonCandidates: ["python"] }))
    .toThrowError(/python compile timed out after 120000 ms/)
})

function probePython(): string | undefined {
  for (const candidate of ["python", "python3"]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" })
    if (result.status === 0 && /Python 3[.]/.test(`${result.stdout ?? ""}${result.stderr ?? ""}`)) return candidate
  }
  return undefined
}

const pythonBin = probePython()
const testPython = test.skipIf(pythonBin === undefined)

testPython("compiles the fixture through the CLI and loads the JSON", () => {
  const bin = pythonBin ?? "python"
  const workspace = mkdtempSync(join(tmpdir(), "xl-build-spec-"))
  const compiled = join(workspace, "py-chain.json")
  try {
    const result = spawnSync(bin, ["-m", "xl_build", "build", FIXTURE, "-o", compiled], {
      env: { ...process.env, PYTHONPATH: resolve("py") },
      encoding: "utf8",
      timeout: 60_000,
    })
    expect(result.status, result.stderr).toBe(0)
    const document = loadWorkflowFile(compiled)
    expect(document.id).toBe("py-chain")
    expect(document.entry).toBe("start")
    expect(document.nodes.map((node) => node.id)).toEqual(["start", "research", "done"])
    expect(document.edges.map((edge) => edge.id)).toEqual(["start-to-research", "research-to-done"])
    expect(document.edges[1]?.format).toBe("md")
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

testPython("loads the .py fixture through the python loader", () => {
  const document = loadPythonWorkflowFile(FIXTURE)
  expect(document.id).toBe("py-chain")
  expect(document.description).toBe("Compiled from the py/xl_build example")
  expect(document.defaults).toEqual({ nodeTimeoutMs: 600000, maxAttempts: 2, edgeMaxBytes: 64000 })
  expect(document.nodes[1]).toMatchObject({
    id: "research",
    kind: "agent",
    agent: "researcher",
    context: "none",
    self: false,
  })
  expect(document.nodes[0]).toMatchObject({ kind: "input", params: [{ name: "topic", required: true }] })
  expect(document.outputs).toEqual({})
})

testPython("routes .py files through the python loader", () => {
  expect(loadWorkflowFile(FIXTURE)).toEqual(loadPythonWorkflowFile(FIXTURE))
})