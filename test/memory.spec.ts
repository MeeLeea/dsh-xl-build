/**
 * Memory milestone tests: the read path injects the workflow's distilled memory once
 * at run start, through the two explicit entries only — the `{{memory}}` template
 * reference and the `context: { from: 'memory' }` preamble — and the `node-input`
 * record holds exactly the text the model received.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { AgentRunInput, AgentRunner } from '../src/host/agents/run.ts'
import { AgentSpecSchema } from '../src/host/agents/spec.ts'
import { parseWorkflowDocument } from '../src/host/workflow/domain.ts'
import { readMemory, type ReadMemoryOptions } from '../src/host/workflow/memory.ts'
import { createRunArtifactStore, startWorkflowRun, type WorkflowRunLimits, type WorkflowRunServices } from '../src/host/workflow/run.ts'
import { XL_EVENTS, type XlEventType } from '../src/host/events.ts'

const LIMITS: WorkflowRunLimits = {
  maxConcurrentNodes: 2,
  maxSteps: 20,
  runTimeoutMs: 5000,
  scriptTimeoutMs: 1000,
  allowedScriptRuntimes: ['shell'],
  retryableToolErrors: [],
}

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

/** One journal record as the sink captured it. */
interface JournalRecord {
  readonly name: XlEventType
  readonly payload: unknown
}

/** A run fixture: one agent node reads the memory through both explicit entries. */
const MEMORY_CHAIN = parseWorkflowDocument({
  schemaVersion: 1,
  id: 'mem-chain',
  name: 'Memory chain',
  entry: 'recall',
  nodes: [
    { kind: 'agent', id: 'recall', agent: 'researcher', task: 'Recall {{memory}}', context: { from: 'memory' } },
  ],
  edges: [],
  outputs: { out: '{{nodes.recall}}' },
})

/**
 * Services with the memory port bound to the given reader; runs stay in memory
 * (`persistRuns: false`) because these tests assert records, not files.
 */
function testHarness(runner: AgentRunner<Agent>, readMemory: (workflowId: string) => string): {
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
    artifacts: createRunArtifactStore({ runsDir: '', runId: 'run-mem', persistRuns: false, sessionId: 'run-root-session', cwd: process.cwd() }),
    loadSubworkflow: (id) => { throw new Error(`workflow "${id}" is not saved`) },
    readMemory,
  }
  return { services, records }
}

describe('readMemory', () => {
  it('returns the file text truncated to the byte ceiling without splitting a code point', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-xl-build-memory-'))
    writeFileSync(join(dir, 'wf.md'), 'a汉汉汉', 'utf8')
    const options: ReadMemoryOptions = { memoryDir: dir, memoryEnabled: true, memoryMaxBytes: 4 }
    expect(readMemory('wf', options)).toBe('a汉')
    expect(readMemory('wf', { ...options, memoryMaxBytes: 10 })).toBe('a汉汉汉')
  })

  it('returns an empty string when the file is missing or memory is disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-xl-build-memory-'))
    expect(readMemory('absent', { memoryDir: dir, memoryEnabled: true, memoryMaxBytes: 100 })).toBe('')
    writeFileSync(join(dir, 'wf.md'), 'kept out', 'utf8')
    expect(readMemory('wf', { memoryDir: dir, memoryEnabled: false, memoryMaxBytes: 100 })).toBe('')
  })
})

describe('memory injection', () => {
  it('injects memory through the template reference and the context preamble, logged identically', async () => {
    const started: AgentRunInput<Agent>[] = []
    const memoryText = 'Persisted fact about releases.'
    const { services, records } = testHarness(stubRunner(completedResult('recalled'), started), () => memoryText)
    const summary = await startWorkflowRun<Agent>({
      document: MEMORY_CHAIN,
      inputs: {},
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    const runStart = records.find((record) => record.name === XL_EVENTS.runStart)?.payload as { memoryBytes?: number }
    expect(runStart.memoryBytes).toBe(Buffer.byteLength(memoryText, 'utf8'))
    expect(started).toHaveLength(1)
    const expectedTask = `[workflow memory]\n${memoryText}\n\nRecall Persisted fact about releases.`
    expect(started[0]?.task).toBe(expectedTask)
    const nodeInput = records.find((record) => record.name === XL_EVENTS.nodeInput)?.payload as { text: string }
    expect(nodeInput.text).toBe(expectedTask)
  })

  it('resolves every entry to empty when no memory was injected and omits memoryBytes', async () => {
    const started: AgentRunInput<Agent>[] = []
    const { services, records } = testHarness(stubRunner(completedResult('recalled'), started), () => '')
    await startWorkflowRun<Agent>({
      document: MEMORY_CHAIN,
      inputs: {},
      limits: LIMITS,
      services,
    }).outcome

    const runStart = records.find((record) => record.name === XL_EVENTS.runStart)?.payload as { memoryBytes?: number }
    expect(runStart.memoryBytes).toBeUndefined()
    expect(started[0]?.task).toBe('Recall ')
    const nodeInput = records.find((record) => record.name === XL_EVENTS.nodeInput)?.payload as { text: string }
    expect(nodeInput.text).toBe('Recall ')
  })
})