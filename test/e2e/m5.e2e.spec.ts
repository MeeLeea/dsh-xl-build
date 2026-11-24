/**
 * M5 acceptance (doc/impl-plan.md §3.6 M5-3): the same workflow runs twice for
 * real. The first run's curation distills a memory file; the second run
 * injects it through both channels, and the injected text is fully
 * reconstructable from the second run's node-input record. Self-skips without
 * DEEPSEEK_API_KEY.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { appendPluginRecord, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createActivationGate } from '../../src/host/agents/gate.ts'
import { createAgentRunner } from '../../src/host/agents/run.ts'
import { loadAgentDirectory, resolveBuiltInAgentsDir } from '../../src/host/agents/registry.ts'
import { AgentSpecSchema } from '../../src/host/agents/spec.ts'
import { parseWorkflowDocument } from '../../src/host/workflow/domain.ts'
import { createMemoryCurator, readMemory, runDigestText } from '../../src/host/workflow/memory.ts'
import {
  createRunArtifactStore,
  startWorkflowRun,
  type WorkflowRecordSink,
  type WorkflowRunLimits,
  type WorkflowRunServices,
} from '../../src/host/workflow/run.ts'
import { XL_EVENTS, type XlEventType } from '../../src/host/events.ts'

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Mount the real loop, model adapter, and subagent port over one context. */
async function mount(workdir: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek, { models: [{ id: 'deepseek-v4-flash' }] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  return ctx
}

/** One journal record as the sinks captured it. */
interface JournalRecord {
  readonly name: XlEventType
  readonly payload: unknown
}

const LIMITS: WorkflowRunLimits = {
  maxConcurrentNodes: 2,
  maxSteps: 20,
  runTimeoutMs: 600_000,
  scriptTimeoutMs: 120_000,
  allowedScriptRuntimes: ['shell'],
  retryableToolErrors: [],
}

const NOTE_TAKER = AgentSpecSchema.parse({
  id: 'note-taker',
  name: 'Note taker',
  description: 'Distills one fact into a compact memory line',
  prompt: '你是流水线上的整理员：把任务交给你的事实整理成一行紧凑的中文记忆条目并输出。不要扩写，不要提问，只输出这一行。',
})

const TOPIC = '季度复盘定在 3 月 14 日，地点是杭州分部'

const DOC = parseWorkflowDocument({
  schemaVersion: 1,
  id: 'memory-e2e',
  name: 'Memory e2e',
  entry: 'start',
  nodes: [
    { kind: 'input', id: 'start', params: [{ name: 'topic', required: true }] },
    {
      kind: 'agent',
      id: 'note',
      agent: 'note-taker',
      task: '当前长期记忆（可能为空）：{{memory}}。请把这条事实整理成一行记忆条目并输出：{{input.topic}}',
      context: { from: 'memory' },
    },
    { kind: 'output', id: 'done', value: '{{nodes.note}}' },
  ],
  edges: [
    { id: 'start-to-note', from: 'start', to: 'note', kind: 'flow' },
    { id: 'note-to-done', from: 'note', to: 'done', kind: 'flow' },
  ],
  outputs: { note: '{{nodes.done}}' },
})

/** Node-end and node-error lines exactly as the host digest assembles them. */
function nodeEventLines(records: readonly JournalRecord[]): string[] {
  return records.flatMap((record) => {
    if (record.name === XL_EVENTS.nodeEnd) {
      const ended = record.payload as { nodeId: string, status: string }
      return ['[node ' + ended.nodeId + '] ' + ended.status]
    }
    if (record.name === XL_EVENTS.nodeError) {
      const failed = record.payload as { nodeId: string, class: string, message: string }
      return ['[node ' + failed.nodeId + '] ' + failed.class + ': ' + failed.message]
    }
    return []
  })
}

/** Real engine services for one run over the mounted context. */
async function runHarness(
  ctx: Context,
  workdir: string,
  runId: string,
  memoryDir: string,
  records: JournalRecord[],
): Promise<{ parent: Agent, services: WorkflowRunServices<Agent> }> {
  const parent = await ctx.agentLoop.create(
    SessionId(randomUUID()),
    { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    { cwd: workdir },
  )
  const record: WorkflowRecordSink = async (name, payload) => {
    records.push({ name, payload })
    appendPluginRecord(parent.session, name, payload)
    await ctx.sessions.flush(parent.session)
  }
  const services: WorkflowRunServices<Agent> = {
    runner: createAgentRunner<Agent>(ctx.subagents, createActivationGate(4)),
    parent,
    initiatorParent: parent,
    resolveAgent: () => NOTE_TAKER,
    record,
    artifacts: createRunArtifactStore({
      runsDir: join(workdir, 'runs'),
      runId,
      persistRuns: true,
      sessionId: parent.id,
      cwd: workdir,
    }),
    loadSubworkflow: (id) => { throw new Error('workflow "' + id + '" is not saved') },
    readMemory: (workflowId) => readMemory(workflowId, { memoryDir, memoryEnabled: true, memoryMaxBytes: 16_000 }),
  }
  return { parent, services }
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('memory e2e: two real runs share distilled memory', () => {
  it('injects the first run distilled conclusion into the second run node-input', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'dsh-xl-build-m5-e2e-'))
    roots.push(workdir)
    const memoryDir = join(workdir, 'memory')
    const ctx = await mount(workdir)
    const runner = createAgentRunner<Agent>(ctx.subagents, createActivationGate(4))
    const curator = createMemoryCurator<Agent>({
      runner,
      curatorId: 'memory-curator',
      memoryDir,
      memoryEnabled: true,
      memoryMaxBytes: 16_000,
    })

    // The shipped built-in curator definition resolves and parses.
    const builtInDir = resolveBuiltInAgentsDir()
    if (builtInDir === undefined) throw new Error('built-in agents dir did not resolve from the plugin tree')
    const curatorEntry = loadAgentDirectory(builtInDir)
      .find((entry) => entry.status === 'valid' && entry.spec.id === 'memory-curator')
    if (curatorEntry?.status !== 'valid') throw new Error('shipped memory-curator definition is missing or invalid')

    // --- Run 1: no memory exists yet, nothing is injected. ---
    const records1: JournalRecord[] = []
    const run1 = await runHarness(ctx, workdir, 'run-1', memoryDir, records1)
    const summary1 = await startWorkflowRun<Agent>({
      document: DOC,
      inputs: { topic: TOPIC },
      runId: 'run-1',
      limits: LIMITS,
      services: run1.services,
    }).outcome
    expect(summary1.outcome).toBe('completed')
    const runStart1 = records1.find((record) => record.name === XL_EVENTS.runStart)?.payload as { memoryBytes?: number }
    expect(runStart1.memoryBytes).toBeUndefined()

    // --- Curation 1: the shipped curator distills run 1 into the file. ---
    const memoryRecords1: JournalRecord[] = []
    await curator.curate({
      runId: summary1.runId,
      workflowId: DOC.id,
      runDigest: runDigestText(summary1, nodeEventLines(records1)),
      parent: run1.parent,
      record: async (payload) => { memoryRecords1.push({ name: XL_EVENTS.memoryUpdated, payload }) },
      resolveCurator: () => curatorEntry.spec,
    })
    const memoryFile = join(memoryDir, DOC.id + '.md')
    await vi.waitFor(() => { expect(existsSync(memoryFile)).toBe(true) }, { timeout: 180_000, interval: 2_000 })
    const memory = readFileSync(memoryFile, 'utf8')
    expect(memory.trim().length).toBeGreaterThan(0)
    expect(memoryRecords1[0]?.payload).toMatchObject({ outcome: 'updated' })

    // --- Run 2: the distilled memory reaches the model through both channels. ---
    const records2: JournalRecord[] = []
    const run2 = await runHarness(ctx, workdir, 'run-2', memoryDir, records2)
    const summary2 = await startWorkflowRun<Agent>({
      document: DOC,
      inputs: { topic: TOPIC },
      runId: 'run-2',
      limits: LIMITS,
      services: run2.services,
    }).outcome
    expect(summary2.outcome).toBe('completed')

    const runStart2 = records2.find((record) => record.name === XL_EVENTS.runStart)?.payload as { memoryBytes?: number }
    expect(runStart2.memoryBytes).toBe(Buffer.byteLength(memory, 'utf8'))
    const noteInput = records2.find((record) => record.name === XL_EVENTS.nodeInput)?.payload as { text: string }
    expect(noteInput.text).toContain('[workflow memory]')
    expect(noteInput.text).toContain(memory)

    // --- Curation 2: the post-run pass settles the updated document. ---
    const memoryRecords2: JournalRecord[] = []
    await curator.curate({
      runId: summary2.runId,
      workflowId: DOC.id,
      runDigest: runDigestText(summary2, nodeEventLines(records2)),
      parent: run2.parent,
      record: async (payload) => { memoryRecords2.push({ name: XL_EVENTS.memoryUpdated, payload }) },
      resolveCurator: () => curatorEntry.spec,
    })
    await vi.waitFor(() => { expect(memoryRecords2.length).toBeGreaterThan(0) }, { timeout: 180_000, interval: 2_000 })
    expect(memoryRecords2[0]?.payload).toMatchObject({ outcome: 'updated' })
    const updated = readFileSync(memoryFile, 'utf8')
    expect(updated.trim().length).toBeGreaterThan(0)
  }, 600_000)
})

