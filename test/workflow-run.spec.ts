/**
 * Host-bound run executor tests: a stub agent runner drives a three-node
 * chain, the run journals durable records, writes artifacts, and settles the
 * summary the command runtime forwards to the initiating session.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { AgentRunInput, AgentRunner } from '../src/host/agents/run.ts'
import { AgentSpecSchema } from '../src/host/agents/spec.ts'
import { parseWorkflowDocument } from '../src/host/workflow/domain.ts'
import { createRunArtifactStore, runNoticeText, startWorkflowRun, type WorkflowRunLimits, type WorkflowRunServices } from '../src/host/workflow/run.ts'
import { XL_EVENTS, type XlEventType } from '../src/host/events.ts'

/** The completed result a stub child ends with. */
function completedResult(text: string): SubagentResult {
  return { output: [{ type: 'text', text }], stopReason: 'completed' }
}

/** One-shot runner: every activation resolves with the given result. */
function stubRunner(result: SubagentResult, started: AgentRunInput<Agent>[] = []): AgentRunner<Agent> {
  return {
    start: async (input) => {
      started.push(input)
      return { childId: 'child-1', result: Promise.resolve(result) }
    },
    disposeAll: async () => {},
  }
}

/** A run fixture: input `topic` feeds a researcher agent, then an output node. */
const CHAIN = parseWorkflowDocument({
  schemaVersion: 1,
  id: 'chain',
  name: 'Chain',
  entry: 'start',
  nodes: [
    { kind: 'input', id: 'start', params: [{ name: 'topic', required: true }] },
    { kind: 'agent', id: 'research', agent: 'researcher', task: 'Research {{input.topic}}' },
    { kind: 'output', id: 'done', value: '{{nodes.research}}' },
  ],
  outputs: { result: '{{nodes.done}}' },
  edges: [
    { id: 'e1', from: 'start', to: 'research', kind: 'flow' },
    { id: 'e2', from: 'research', to: 'done', kind: 'flow' },
  ],
})

const LIMITS: WorkflowRunLimits = {
  maxConcurrentNodes: 2,
  maxSteps: 20,
  runTimeoutMs: 5000,
  scriptTimeoutMs: 1000,
  allowedScriptRuntimes: ['shell'],
  retryableToolErrors: [],
}

/** One journal record as the sink captured it. */
interface JournalRecord {
  readonly name: XlEventType
  readonly payload: unknown
}

/**
 * Services over a temp runs directory: agents resolve through the schema,
 * records land in the array, and the fake parents are minimal agents.
 */
function testHarness(runner: AgentRunner<Agent>, runId: string, runsDir: string): {
  readonly services: WorkflowRunServices<Agent>
  readonly records: JournalRecord[]
} {
  const records: JournalRecord[] = []
  const services: WorkflowRunServices<Agent> = {
    runner,
    parent: { id: SessionId('run-root') } as Agent,
    initiatorParent: { id: SessionId('initiator'), followup: () => {} } as Agent,
    resolveAgent: (id) => AgentSpecSchema.parse({
      id,
      name: id,
      description: `stub ${id} agent`,
      prompt: 'You are a stub.',
    }),
    record: async (name, payload) => { records.push({ name, payload }) },
    artifacts: createRunArtifactStore({ runsDir, runId, persistRuns: true, sessionId: 'run-root-session', cwd: process.cwd() }),
    loadSubworkflow: (id) => { throw new Error(`workflow "${id}" is not saved`) },
    readMemory: () => '',
  }
  return { services, records }
}

describe('startWorkflowRun', () => {
  it('completes a three-node chain, journals the run, and writes the output artifact', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'dsh-xl-build-runs-'))
    const runId = 'run-1'
    const { services, records } = testHarness(stubRunner(completedResult('done')), runId, runsDir)
    const summary = await startWorkflowRun<Agent>({
      document: CHAIN,
      inputs: { topic: 'k8s' },
      runId,
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    expect(summary.outputs.result).toBe('done')

    const byName = (name: XlEventType) => records.filter((record) => record.name === name)
    expect(byName(XL_EVENTS.runStart)).toHaveLength(1)
    expect(byName(XL_EVENTS.runStart)[0]?.payload).toMatchObject({ runId, workflowId: 'chain' })
    expect(byName(XL_EVENTS.nodeStart).map((r) => (r.payload as { nodeId: string }).nodeId).sort())
      .toEqual(['done', 'research', 'start'])
    expect(byName(XL_EVENTS.nodeInput).map((r) => (r.payload as { text: string }).text))
      .toContain('Research k8s')
    expect(byName(XL_EVENTS.nodeEnd)).toHaveLength(3)
    expect(byName(XL_EVENTS.nodeEnd).every((r) => (r.payload as { status: string }).status === 'completed')).toBe(true)
    expect(byName(XL_EVENTS.runEnd)[0]?.payload).toMatchObject({ outcome: 'completed' })
    expect(byName(XL_EVENTS.edgeTransfer).length).toBeGreaterThan(0)
    const doneEnd = byName(XL_EVENTS.nodeEnd).map((r) => r.payload as { nodeId: string, artifacts: { nodeId: string, path: string, title?: string }[] })
      .find((payload) => payload.nodeId === 'done')
    expect(doneEnd?.artifacts[0]).toMatchObject({
      nodeId: 'done',
      title: 'output.md',
    })
    expect(doneEnd?.artifacts[0]?.path.startsWith('dsh-resource://file/session/run-root-session/')).toBe(true)
    expect(doneEnd?.artifacts[0]?.path).toContain('artifacts/done/output.md')

    const runDir = join(runsDir, runId)
    expect(existsSync(join(runDir, 'workflow.json'))).toBe(true)
    expect(readFileSync(join(runDir, 'artifacts', 'done', 'output.md'), 'utf8')).toBe('done')
    const names = readFileSync(join(runDir, 'journal.jsonl'), 'utf8').trim().split('\n')
      .map((line) => (JSON.parse(line) as { name: string }).name)
    expect(names[0]).toBe(XL_EVENTS.runStart)
    expect(names.at(-1)).toBe(XL_EVENTS.runEnd)

    const notice = runNoticeText(summary, runsDir)
    expect(notice).toContain(runId)
    expect(notice).toContain('Output: ' + join(runsDir, runId, 'artifacts', 'done', 'output.md'))
  })

  it('fails the run when the agent ends with an error and reports the failure', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'dsh-xl-build-runs-'))
    const runId = 'run-err'
    const { services, records } = testHarness(
      stubRunner({ output: [], stopReason: 'error', diagnostic: 'provider boom' }),
      runId,
      runsDir,
    )
    const summary = await startWorkflowRun<Agent>({
      document: CHAIN,
      inputs: { topic: 'k8s' },
      runId,
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('failed')
    const nodeErrors = records.filter((r) => r.name === XL_EVENTS.nodeError)
    expect(nodeErrors).toHaveLength(2)
    expect(nodeErrors.map((r) => (r.payload as { attempt: number }).attempt)).toEqual([1, 2])
    expect(nodeErrors[0]?.payload).toMatchObject({ class: 'transient', message: 'provider boom' })
    expect(byRecordName(records, XL_EVENTS.runEnd)).toMatchObject({ outcome: 'failed' })

    const notice = runNoticeText(summary, runsDir)
    expect(notice).toContain('failed')
    expect(notice).toContain('research')
    expect(notice).not.toContain('Output:')
  })

  it('fails the run when required inputs are missing', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'dsh-xl-build-runs-'))
    const { services } = testHarness(stubRunner(completedResult('done')), 'run-missing', runsDir)
    const summary = await startWorkflowRun<Agent>({
      document: CHAIN,
      inputs: {},
      runId: 'run-missing',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('failed')
    expect(summary.failures.some((failure) => failure.message.includes('missing required run inputs: topic')))
      .toBe(true)
  })

  it('starts self nodes under the initiating parent', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'dsh-xl-build-runs-'))
    const selfChain = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'self-chain',
      name: 'Self Chain',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'agent', id: 'me', agent: 'researcher', task: 't', self: true },
        { kind: 'output', id: 'done', value: '{{nodes.me.output}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'me', kind: 'flow' },
        { id: 'e2', from: 'me', to: 'done', kind: 'flow' },
      ],
    })
    const started: AgentRunInput<Agent>[] = []
    const { services } = testHarness(stubRunner(completedResult('done'), started), 'run-self', runsDir)
    const summary = await startWorkflowRun<Agent>({
      document: selfChain,
      inputs: {},
      runId: 'run-self',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    expect(started).toHaveLength(1)
    expect(started[0]?.parent).toBe(services.initiatorParent)
  })
})

/** The payload of the one record with this name. */
function byRecordName(records: Record[], name: XlEventType): unknown {
  const found = records.filter((record) => record.name === name)
  expect(found).toHaveLength(1)
  return found[0]?.payload
}
