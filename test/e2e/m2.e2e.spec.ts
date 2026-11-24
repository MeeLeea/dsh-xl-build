/**
 * M2 acceptance (doc/impl-plan.md test table): a real model runs the 3-node
 * chain through the engine — run input feeds the agent node, the agent output
 * reaches the output node, and the journal records the graph order.
 * Self-skips without DEEPSEEK_API_KEY.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, describe, expect, it } from 'vitest'
import { createActivationGate } from '../../src/host/agents/gate.ts'
import { createAgentRunner } from '../../src/host/agents/run.ts'
import { AgentSpecSchema } from '../../src/host/agents/spec.ts'
import { parseWorkflowDocument } from '../../src/host/workflow/domain.ts'
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

const RUNNER_AGENT = AgentSpecSchema.parse({
  id: 'researcher',
  name: 'Researcher',
  description: 'Answers with one concise sentence.',
  prompt: '你是研究员。收到主题后，用一句简洁的中文概括它；不要提问，不要输出其他内容。',
})

const DOC = parseWorkflowDocument({
  schemaVersion: 1,
  id: 'chain-e2e',
  name: 'Chain e2e',
  entry: 'start',
  nodes: [
    { kind: 'input', id: 'start', params: [{ name: 'topic', required: true }] },
    { kind: 'agent', id: 'research', agent: 'researcher', task: '请用一句话概括这个主题：{{input.topic}}' },
    { kind: 'output', id: 'done', value: '{{nodes.research}}' },
  ],
  edges: [
    { id: 'start-to-research', from: 'start', to: 'research', kind: 'flow' },
    { id: 'research-to-done', from: 'research', to: 'done', kind: 'flow' },
  ],
  outputs: { report: '{{nodes.done}}' },
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('m2 e2e: real model runs the 3-node chain', () => {
  it('settles input, agent, and output nodes in graph order', async () => {
    const workdir = mkdtempSync(join(tmpdir(), 'dsh-xl-build-m2-e2e-'))
    roots.push(workdir)
    const ctx = await mount(workdir)
    const parent = await ctx.agentLoop.create(
      SessionId(randomUUID()),
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      { cwd: workdir },
    )
    const records: JournalRecord[] = []
    const record: WorkflowRecordSink = async (name, payload) => { records.push({ name, payload }) }
    const services: WorkflowRunServices<Agent> = {
      runner: createAgentRunner<Agent>(ctx.subagents, createActivationGate(4)),
      parent,
      initiatorParent: parent,
      resolveAgent: () => RUNNER_AGENT,
      record,
      artifacts: createRunArtifactStore({
        runsDir: join(workdir, 'runs'),
        runId: 'run-1',
        persistRuns: false,
        sessionId: parent.id,
        cwd: workdir,
      }),
      loadSubworkflow: (id) => { throw new Error('workflow "' + id + '" is not saved') },
      readMemory: () => '',
    }

    const summary = await startWorkflowRun<Agent>({
      document: DOC,
      inputs: { topic: '杭州亚运会' },
      runId: 'run-1',
      limits: LIMITS,
      services,
    }).outcome
    expect(summary.outcome).toBe('completed')
    expect(typeof summary.outputs.report).toBe('string')
    expect((summary.outputs.report as string).length).toBeGreaterThan(0)

    // The journal records the graph order: runStart first, runEnd last.
    const names = records.map((entry) => entry.name)
    expect(names[0]).toBe(XL_EVENTS.runStart)
    expect(names[names.length - 1]).toBe(XL_EVENTS.runEnd)
    const nodeStarts = records.filter((entry) => entry.name === XL_EVENTS.nodeStart)
    expect(nodeStarts.length).toBe(3)

    const ended = records
      .filter((entry) => entry.name === XL_EVENTS.nodeEnd)
      .map((entry) => {
        const payload = entry.payload as { nodeId: string, status: string }
        return payload.nodeId + ' ' + payload.status
      })
    expect(ended).toEqual(['start completed', 'research completed', 'done completed'])

    const transferred = records
      .filter((entry) => entry.name === XL_EVENTS.edgeTransfer)
      .map((entry) => {
        const payload = entry.payload as { from: string, to: string }
        return { from: payload.from, to: payload.to }
      })
    expect(transferred).toEqual([
      { from: 'start', to: 'research' },
      { from: 'research', to: 'done' },
    ])
  }, 600_000)
})

