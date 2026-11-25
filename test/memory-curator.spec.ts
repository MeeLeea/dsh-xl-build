/**
 * Memory curation: the post-run pass rewrites the workflow memory file through the
 * shared agent runner, keeps the previous memory on every failure mode, and
 * serializes concurrent passes for the same workflow id.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { createAgentRegistry, loadAgentDirectory, resolveBuiltInAgentsDir } from '../src/host/agents/registry.ts'
import type { AgentRunInput, AgentRunner } from '../src/host/agents/run.ts'
import { AgentSpecSchema } from '../src/host/agents/spec.ts'
import { createMemoryCurator, runDigestText, type CurateMemoryInput } from '../src/host/workflow/memory.ts'
import type { MemoryUpdatedPayload } from '../src/host/events.ts'

const CURATOR_SPEC = AgentSpecSchema.parse({
  id: 'memory-curator',
  name: 'Memory curator',
  description: 'stub curator',
  prompt: 'Curate.',
  outputSchema: { type: 'object', properties: { memory: { type: 'string' } }, required: ['memory'] },
})

const TEMP_ROOT = mkdtempSync(join(tmpdir(), `xl-build-curator-`))

afterEach(() => {
  rmSync(join(TEMP_ROOT, `case-${Date.now()}`), { recursive: true, force: true })
})

function newCaseDir(): string {
  const dir = join(TEMP_ROOT, `case-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function completedStructured(memory: string): SubagentResult {
  return { output: [], stopReason: 'completed', structured: { memory } }
}

/** Runner that resolves each start with the next scripted result. */
function scriptedRunner(
  results: Array<() => SubagentResult>,
  started: AgentRunInput<Agent>[] = [],
): AgentRunner<Agent> {
  return {
    start: async (input) => {
      started.push(input)
      const produce = results.shift() ?? (() => completedStructured("fallback"))
      return { childId: `child-${started.length}`, result: Promise.resolve(produce()) }
    },
    disposeAll: async () => {},
  }
}

function curatorFor(runner: AgentRunner<Agent>, memoryDir: string) {
  const records: MemoryUpdatedPayload[] = []
  const curator = createMemoryCurator<Agent>({
    runner,
    curatorId: 'memory-curator',
    memoryDir,
    memoryEnabled: true,
    memoryMaxBytes: 4000,
  })
  const curate = (input?: Partial<CurateMemoryInput<Agent>>): Promise<void> => curator.curate({
    runId: 'run-1',
    workflowId: 'wf-1',
    runDigest: '[node a] completed',
    parent: { id: SessionId('curator-parent') } as Agent,
    record: async (payload) => { records.push(payload) },
    resolveCurator: () => CURATOR_SPEC,
    ...input,
  })
  return { records, curate }
}

/** Flush the microtask queue enough for queued passes to start or finish. */
async function settle(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('memory curation', () => {
  it('writes the curated memory and records the update', async () => {
    const dir = newCaseDir()
    writeFileSync(join(dir, 'wf-1.md'), 'old memory', 'utf8')
    const started: AgentRunInput<Agent>[] = []
    const { records, curate } = curatorFor(scriptedRunner([() => completedStructured("curated text")], started), dir)
    await curate()
    expect(readFileSync(join(dir, 'wf-1.md'), 'utf8')).toBe('curated text')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ outcome: 'updated', bytes: Buffer.byteLength('curated text', 'utf8') })
    expect(records[0]?.runId).toBe('run-1')
    expect(started[0]?.task).toContain('[run digest]')
    expect(started[0]?.task).toContain('[node a] completed')
    expect(started[0]?.task).toContain('[workflow memory]')
    expect(started[0]?.task).toContain('old memory')
    expect(started[0]?.delivery).toBe('caller')
  })

  it('keeps the previous memory when the activation refuses', async () => {
    const dir = newCaseDir()
    const { records, curate } = curatorFor(
      scriptedRunner([() => ({ output: [], stopReason: 'refusal' })]),
      dir,
    )
    await curate()
    expect(() => readFileSync(join(dir, `wf-1.md`), `utf8`)).toThrow()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ version: 1, runId: 'run-1', workflowId: 'wf-1', outcome: 'kept' })
    expect(records[0]?.reason).toContain('refusal')
  })

  it('keeps the previous memory when the curated text exceeds the ceiling', async () => {
    const dir = newCaseDir()
    const { records, curate } = curatorFor(scriptedRunner([() => completedStructured(`x`.repeat(4001))]), dir)
    await curate()
    expect(records[0]?.outcome).toBe('kept')
    expect(records[0]?.reason).toContain('4001 bytes, over the 4000-byte ceiling')
  })

  it('keeps the previous memory when the structured output mismatches', async () => {
    const dir = newCaseDir()
    const { records, curate } = curatorFor(
      scriptedRunner([() => ({ output: [], stopReason: 'completed', structured: { memory: 42 } })]),
      dir,
    )
    await curate()
    expect(records[0]?.outcome).toBe('kept')
    expect(records[0]?.reason).toContain('schema')
  })

  it('keeps the previous memory when the curator agent is not defined', async () => {
    const dir = newCaseDir()
    const { records, curate } = curatorFor(scriptedRunner([]), dir)
    await curate({ resolveCurator: () => undefined })
    expect(records).toHaveLength(1)
    expect(records[0]?.outcome).toBe('kept')
    expect(records[0]?.reason).toContain('not defined')
  })

  it('keeps the previous memory when the write fails', async () => {
    const notADir = join(newCaseDir(), `blocked-${Date.now()}`)
    writeFileSync(notADir, 'a file where the memory directory should be', 'utf8')
    const { records, curate } = curatorFor(scriptedRunner([() => completedStructured("new")]), notADir)
    await curate()
    expect(records[0]?.outcome).toBe('kept')
    expect(records[0]?.reason).toContain('memory write failed:')
  })

  it('serializes passes for the same workflow id FIFO', async () => {
    const dir = newCaseDir()
    const started: AgentRunInput<Agent>[] = []
    let releaseFirst: (result: SubagentResult) => void = () => {}
    const deferredFirst = new Promise<SubagentResult>((resolve) => { releaseFirst = resolve })
    const runner: AgentRunner<Agent> = {
      start: async (input) => {
        started.push(input)
        return started.length === 1
          ? { childId: `child-0`, result: deferredFirst }
          : { childId: `child-${started.length}`, result: Promise.resolve(completedStructured(`B-content`)) }
      },
      disposeAll: async () => {},
    }
    const { records, curate } = curatorFor(runner, dir)
    const first = curate()
    await settle()
    expect(started).toHaveLength(1)
    const second = curate()
    await settle()
    expect(started).toHaveLength(1)
    releaseFirst(completedStructured(`A-content`))
    await Promise.all([first, second])
    expect(started).toHaveLength(2)
    expect(readFileSync(join(dir, `wf-1.md`), `utf8`)).toBe('B-content')
    expect(records.map((record) => record.bytes)).toEqual([
      Buffer.byteLength(`A-content`, `utf8`),
      Buffer.byteLength(`B-content`, `utf8`),
    ])
  })

  it('aborts the in-flight curation activation on dispose', async () => {
    const dir = newCaseDir()
    const started: AgentRunInput<Agent>[] = []
    let release: (result: SubagentResult) => void = () => {}
    const pending = new Promise<SubagentResult>((resolve) => { release = resolve })
    const runner: AgentRunner<Agent> = {
      start: async (input) => {
        started.push(input)
        return { childId: 'child-0', result: pending }
      },
      disposeAll: async () => {},
    }
    const curator = createMemoryCurator<Agent>({
      runner,
      curatorId: 'memory-curator',
      memoryDir: dir,
      memoryEnabled: true,
      memoryMaxBytes: 4000,
    })
    const pass = curator.curate({
      runId: 'run-1',
      workflowId: 'wf-1',
      runDigest: 'd',
      parent: { id: SessionId('curator-parent') } as Agent,
      record: async () => {},
      resolveCurator: () => CURATOR_SPEC,
    })
    await settle()
    expect(started).toHaveLength(1)
    // The curator owns the signal it hands the runner.
    expect(started[0]?.signal.aborted).toBe(false)

    curator.dispose()
    expect(started[0]?.signal.aborted).toBe(true)

    release(completedStructured('after dispose'))
    await pass
  })

  it('does nothing when memory is disabled', async () => {
    const dir = newCaseDir()
    const started: AgentRunInput<Agent>[] = []
    const records: MemoryUpdatedPayload[] = []
    const curator = createMemoryCurator<Agent>({
      runner: scriptedRunner([], started),
      curatorId: 'memory-curator',
      memoryDir: dir,
      memoryEnabled: false,
      memoryMaxBytes: 4000,
    })
    await curator.curate({
      runId: 'run-1',
      workflowId: 'wf-1',
      runDigest: 'd',
      parent: { id: SessionId('curator-parent') } as Agent,
      record: async (payload) => { records.push(payload) },
      resolveCurator: () => CURATOR_SPEC,
    })
    expect(started).toHaveLength(0)
    expect(records).toHaveLength(0)
  })

  it('bounds the run digest: outcome, node events, artifacts, and capped outputs', () => {
    const digest = runDigestText(
      {
        runId: 'r',
        workflowId: 'wf',
        outcome: 'completed',
        totalDurationMs: 12,
        artifacts: [{ id: `a.md`, nodeId: `done`, kind: `file`, path: `dsh-resource://file/session/s/a.md`, title: `a.md` }],
        failures: [],
        outputs: { report: `v`.repeat(600) },
      },
      ['[node a] completed'],
    )
    expect(digest).toContain('run r on workflow wf: completed in 12ms')
    expect(digest).toContain('[node a] completed')
    expect(digest).toContain('[artifact done] a.md')
    expect(digest).toContain('[output report] ' + `v`.repeat(500) + `…`)
  })
})

describe('built-in memory curator', () => {
  it('ships a loadable memory-curator definition', () => {
    const builtIn = resolveBuiltInAgentsDir()
    expect(builtIn).toBeDefined()
    const entries = loadAgentDirectory(builtIn!)
    const curator = entries.find((entry) => entry.status === `valid` && entry.spec.id === `memory-curator`)
    expect(curator?.status).toBe(`valid`)
    expect(curator?.status === `valid` && curator.spec.outputSchema).toBeDefined()
  })

  it('lets the user directory shadow the built-in curator', () => {
    const builtIn = resolveBuiltInAgentsDir()!
    const userDir = newCaseDir()
    writeFileSync(join(userDir, 'memory-curator.yml'), 'id: memory-curator\nname: User curator\ndescription: shadow\nprompt: mine\n', 'utf8')
    const registry = createAgentRegistry({ effect: (callback) => callback() }, { agentsDir: userDir }, { dir: builtIn })
    expect(registry.resolveAgent('memory-curator')?.name).toBe('User curator')
    expect(registry.resolveAgent('memory-curator')?.prompt).toBe('mine')
    const ownerEntries = registry.listAgents().filter((entry) => entry.status === `valid` && entry.spec.id === `memory-curator`)
    expect(ownerEntries).toHaveLength(1)
    expect(ownerEntries[0]?.status === `valid` && ownerEntries[0].spec.name).toBe('User curator')
  })

  it('exposes the built-in curator when the user directory has none', () => {
    const builtIn = resolveBuiltInAgentsDir()!
    const userDir = newCaseDir()
    const registry = createAgentRegistry({ effect: (callback) => callback() }, { agentsDir: userDir }, { dir: builtIn })
    expect(registry.resolveAgent('memory-curator')?.name).toBe('Memory curator')
  })

  it('rejects a broken built-in definition at load', () => {
    const brokenDir = newCaseDir()
    writeFileSync(join(brokenDir, 'memory-curator.yml'), 'id: memory-curator\nprompt: "missing fields"\n', 'utf8')
    expect(() => createAgentRegistry({ effect: (callback) => callback() }, { agentsDir: newCaseDir() }, { dir: brokenDir }))
      .toThrow(/built-in agent definition is invalid/)
  })
})
