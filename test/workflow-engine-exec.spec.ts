/**
 * Execution-level workflow engine tests.
 *
 * The pure-function specs cover each decision in isolation; these drive a real
 * `startWorkflowRun` through a recording stub `AgentRunner` so the runtime
 * wiring of joins, loops, routers, error edges, and subworkflows is observed:
 * which nodes execute, how often, and what each one's output carries.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { AgentRunner } from '../src/host/agents/run.ts'
import { AgentSpecSchema } from '../src/host/agents/spec.ts'
import { parseWorkflowDocument } from '../src/host/workflow/domain.ts'
import type { WorkflowDocument } from '../src/host/workflow/domain.ts'
import {
  createRunArtifactStore,
  startWorkflowRun,
  type WorkflowRunLimits,
  type WorkflowRunServices,
} from '../src/host/workflow/run.ts'
import { XL_EVENTS, type XlEventType } from '../src/host/events.ts'

/** The completed result a stub child ends with. */
function completedResult(text: string): SubagentResult {
  return { output: [{ type: 'text', text }], stopReason: 'completed' }
}

/** One recorded activation: the agent whose id is its node id, its prompt, and its signal. */
interface StubCall {
  readonly nodeId: string
  readonly prompt: string
  readonly signal: AbortSignal
}

/** A runner that records every activation and answers each through `respond`. */
function recordingRunner(
  calls: StubCall[],
  respond: (nodeId: string) => SubagentResult = (nodeId) => completedResult(`result-${nodeId}`),
): AgentRunner<Agent> {
  return {
    start: async (input) => {
      calls.push({ nodeId: input.spec.id, prompt: input.task, signal: input.signal })
      return { childId: `child-${calls.length}`, result: Promise.resolve(respond(input.spec.id)) }
    },
    disposeAll: async () => {},
  }
}

const LIMITS: WorkflowRunLimits = {
  maxConcurrentNodes: 4,
  maxSteps: 50,
  runTimeoutMs: 5000,
  scriptTimeoutMs: 1000,
  allowedScriptRuntimes: ['shell'],
  retryableToolErrors: [],
}

/** One durable record as the sink captured it. */
interface JournalRecord {
  readonly name: XlEventType
  readonly payload: unknown
}

/**
 * Services over an in-memory journal: agents resolve through the schema, so
 * each agent node's `agent` id is its node id, records land in an array, and
 * runs do not touch disk.
 * @param runner - the stub agent runner under test.
 * @param loadSubworkflow - child-document resolver; absent rejects every id.
 * @returns the run services and the captured records.
 */
function harness(runner: AgentRunner<Agent>, loadSubworkflow?: (id: string) => WorkflowDocument): {
  readonly services: WorkflowRunServices<Agent>
  readonly records: JournalRecord[]
} {
  const records: JournalRecord[] = []
  const services: WorkflowRunServices<Agent> = {
    runner,
    parent: { id: SessionId('run-root') } as Agent,
    initiatorParent: { id: SessionId('initiator'), followup: () => {} } as Agent,
    resolveAgent: (id) => AgentSpecSchema.parse({ id, name: id, description: `stub ${id}`, prompt: 'You are a stub.' }),
    record: async (name, payload) => { records.push({ name, payload }) },
    artifacts: createRunArtifactStore({
      runsDir: 'unused',
      runId: 'unused',
      persistRuns: false,
      sessionId: 'run-root-session',
      cwd: process.cwd(),
    }),
    loadSubworkflow: loadSubworkflow ?? (() => { throw new Error('no subworkflow catalog') }),
    readMemory: () => '',
  }
  return { services, records }
}

/** The node ids that produced a `node-start` record, in order. */
function startedNodes(records: readonly JournalRecord[]): string[] {
  return records
    .filter((record) => record.name === XL_EVENTS.nodeStart)
    .map((record) => (record.payload as { nodeId: string }).nodeId)
}

describe('workflow engine execution', () => {
  it('merges every upstream payload into the join output', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'diamond',
      name: 'Diamond',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'agent', id: 'aa', agent: 'aa', task: 'aa' },
        { kind: 'agent', id: 'bb', agent: 'bb', task: 'bb' },
        { kind: 'join', id: 'merge', strategy: 'all' },
        { kind: 'output', id: 'out', value: '{{nodes.merge}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'aa', kind: 'fan-out' },
        { id: 'e2', from: 'start', to: 'bb', kind: 'fan-out' },
        { id: 'e3', from: 'aa', to: 'merge', kind: 'fan-in' },
        { id: 'e4', from: 'bb', to: 'merge', kind: 'fan-in' },
        { id: 'e5', from: 'merge', to: 'out', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.out}}' },
    })
    const calls: StubCall[] = []
    const { services, records } = harness(recordingRunner(calls))
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'diamond',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    expect(startedNodes(records)).toContain('merge')
    expect(calls.map((call) => call.nodeId)).toEqual(['aa', 'bb'])
    const merged = summary.outputs.result ?? ''
    expect(merged).toContain('[from aa]')
    expect(merged).toContain('[from bb]')
    expect(merged).toContain('result-aa')
    expect(merged).toContain('result-bb')
    // Exactly one merged section per upstream proves the consumed arrivals reached the join.
    expect(merged.match(/\[from aa\]/g)).toHaveLength(1)
    expect(merged.match(/\[from bb\]/g)).toHaveLength(1)
  })

  it('runs the loop body once per round and never again at the top level', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'loop-flow',
      name: 'Loop',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        {
          kind: 'loop',
          id: 'spin',
          body: 'body',
          // Never converges, so the run reaches the iteration cap.
          until: { expr: '{"==":[{"var":"nodes.body"},"done"]}' },
          maxIters: 3,
          // `onMaxIters` defaults to `fail`; stopping lets the loop converge on
          // its carry payload so the output can be asserted.
          onMaxIters: 'stop',
        },
        { kind: 'agent', id: 'body', agent: 'body', task: 'body' },
        { kind: 'output', id: 'done', value: '{{nodes.spin}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'spin', kind: 'flow' },
        { id: 'e2', from: 'spin', to: 'body', kind: 'flow' },
        { id: 'e3', from: 'body', to: 'spin', kind: 'loop-back' },
        { id: 'e4', from: 'spin', to: 'done', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done}}' },
    })
    const calls: StubCall[] = []
    const { services, records } = harness(recordingRunner(calls))
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'loop-flow',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    const bodyCalls = calls.filter((call) => call.nodeId === 'body')
    expect(bodyCalls).toHaveLength(3)
    expect(bodyCalls.every((call) => call.prompt === 'body')).toBe(true)
    expect(startedNodes(records).filter((id) => id === 'body')).toHaveLength(3)
    // The carry payload is the loop-back edge's last value, i.e. the body's output.
    expect(summary.outputs.result).toBe('result-body')
  })

  it('runs a nested loop body inside each outer round without an extra per-round execution', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'nested-loop',
      name: 'Nested loop',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        {
          kind: 'loop',
          id: 'outer',
          body: 'outer-body',
          until: { expr: '{"==":[{"var":"nodes.tail"},"never"]}' },
          maxIters: 2,
          onMaxIters: 'stop',
        },
        { kind: 'agent', id: 'outer-body', agent: 'outer-body', task: 'outer-body' },
        {
          kind: 'loop',
          id: 'inner',
          body: 'inner-body',
          until: { expr: '{"==":[{"var":"nodes.inner-body"},"never"]}' },
          maxIters: 2,
          onMaxIters: 'stop',
        },
        { kind: 'agent', id: 'inner-body', agent: 'inner-body', task: 'inner-body' },
        { kind: 'agent', id: 'tail', agent: 'tail', task: 'tail' },
        { kind: 'output', id: 'done', value: '{{nodes.outer}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'outer', kind: 'flow' },
        { id: 'e2', from: 'outer', to: 'outer-body', kind: 'flow' },
        { id: 'e3', from: 'outer-body', to: 'inner', kind: 'flow' },
        { id: 'e4', from: 'inner', to: 'inner-body', kind: 'flow' },
        { id: 'e5', from: 'inner-body', to: 'inner', kind: 'loop-back' },
        { id: 'e6', from: 'inner', to: 'tail', kind: 'flow' },
        { id: 'e7', from: 'tail', to: 'outer', kind: 'loop-back' },
        { id: 'e8', from: 'outer', to: 'done', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done}}' },
    })
    const calls: StubCall[] = []
    const { services, records } = harness(recordingRunner(calls))
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'nested-loop',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    const countOf = (nodeId: string): number => calls.filter((call) => call.nodeId === nodeId).length
    // outerIters * innerIters, never one extra inner-body run per outer round.
    expect(countOf('inner-body')).toBe(4)
    expect(startedNodes(records).filter((id) => id === 'inner-body')).toHaveLength(4)
    // Each outer round runs its body entry and its tail exactly once.
    expect(countOf('outer-body')).toBe(2)
    expect(countOf('tail')).toBe(2)
  })

  it('executes only the router-selected branch and skips its sibling', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'router-flow',
      name: 'Router',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [{ name: 'mode', required: false, default: 'prod' }] },
        { kind: 'router', id: 'pick', branches: [{ when: '{"==":[{"var":"input.mode"},"prod"]}', to: 'aa' }], else: 'bb' },
        { kind: 'agent', id: 'aa', agent: 'aa', task: 'aa' },
        { kind: 'agent', id: 'bb', agent: 'bb', task: 'bb' },
        { kind: 'output', id: 'done-a', value: '{{nodes.aa}}' },
        { kind: 'output', id: 'done-b', value: '{{nodes.bb}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'pick', kind: 'flow' },
        { id: 'e2', from: 'pick', to: 'aa', kind: 'branch', condition: '{"==":[{"var":"input.mode"},"prod"]}' },
        { id: 'e3', from: 'pick', to: 'bb', kind: 'branch' },
        { id: 'e4', from: 'aa', to: 'done-a', kind: 'flow' },
        { id: 'e5', from: 'bb', to: 'done-b', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done-b}}' },
    })
    const calls: StubCall[] = []
    const { services, records } = harness(recordingRunner(calls))
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: { mode: 'dev' },
      runId: 'router-flow',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    expect(calls.map((call) => call.nodeId)).toEqual(['bb'])
    const started = startedNodes(records)
    expect(started).toContain('bb')
    expect(started).toContain('done-b')
    expect(started).not.toContain('aa')
    expect(started).not.toContain('done-a')
    expect(summary.outputs.result).toBe('result-bb')
  })

  it('activates an error handler only on failure and never after success', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'error-flow',
      name: 'Error flow',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'agent', id: 'aa', agent: 'aa', task: 'aa' },
        { kind: 'agent', id: 'handler', agent: 'handler', task: 'handler' },
        { kind: 'output', id: 'done', value: '{{nodes.aa}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'aa', kind: 'flow' },
        { id: 'e2', from: 'aa', to: 'handler', kind: 'error' },
        { id: 'e3', from: 'aa', to: 'done', kind: 'flow' },
        { id: 'e4', from: 'handler', to: 'done', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done}}' },
    })

    const successCalls: StubCall[] = []
    const success = harness(recordingRunner(successCalls))
    const successSummary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'error-success',
      limits: LIMITS,
      services: success.services,
    }).outcome
    expect(successSummary.outcome).toBe('completed')
    expect(successCalls.some((call) => call.nodeId === 'handler')).toBe(false)

    const failureCalls: StubCall[] = []
    const failure = harness(recordingRunner(
      failureCalls,
      (nodeId) => (nodeId === 'aa'
        ? { output: [], stopReason: 'error', diagnostic: 'provider boom' }
        : completedResult(`result-${nodeId}`)),
    ))
    const failureSummary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'error-failure',
      limits: LIMITS,
      services: failure.services,
    }).outcome
    expect(failureSummary.outcome).toBe('failed')
    expect(failureCalls.filter((call) => call.nodeId === 'handler')).toHaveLength(1)
  })

  it('runs an any join when one upstream fails but skips an all join', async () => {
    /** The same diamond with a configurable join strategy. */
    function joinGraph(strategy: 'all' | 'any' | 'quorum', quorum?: number): WorkflowDocument {
      return parseWorkflowDocument({
        schemaVersion: 1,
        id: 'join-flow',
        name: 'Join flow',
        entry: 'start',
        nodes: [
          { kind: 'input', id: 'start', params: [] },
          { kind: 'agent', id: 'aa', agent: 'aa', task: 'aa' },
          { kind: 'agent', id: 'bb', agent: 'bb', task: 'bb' },
          { kind: 'join', id: 'merge', strategy, ...quorum === undefined ? {} : { quorum } },
          { kind: 'output', id: 'out', value: '{{nodes.merge}}' },
        ],
        edges: [
          { id: 'e1', from: 'start', to: 'aa', kind: 'fan-out' },
          { id: 'e2', from: 'start', to: 'bb', kind: 'fan-out' },
          { id: 'e3', from: 'aa', to: 'merge', kind: 'fan-in' },
          { id: 'e4', from: 'bb', to: 'merge', kind: 'fan-in' },
          { id: 'e5', from: 'merge', to: 'out', kind: 'flow' },
        ],
        outputs: { result: '{{nodes.out}}' },
      })
    }

    const respondWithFailure = (nodeId: string): SubagentResult => (nodeId === 'aa'
      ? { output: [], stopReason: 'error', diagnostic: 'provider boom' }
      : completedResult(`result-${nodeId}`))

    const runJoin = async (document: WorkflowDocument, runId: string) => {
      const calls: StubCall[] = []
      const { services, records } = harness(recordingRunner(calls, respondWithFailure))
      const summary = await startWorkflowRun<Agent>({
        document,
        inputs: {},
        runId,
        limits: LIMITS,
        services,
      }).outcome
      return { summary, records }
    }

    const anyRun = await runJoin(joinGraph('any'), 'join-any')
    expect(anyRun.summary.outcome).toBe('failed')
    expect(startedNodes(anyRun.records)).toContain('merge')
    expect(anyRun.summary.outputs.result ?? '').toContain('[from bb]')
    expect(anyRun.summary.outputs.result ?? '').toContain('result-bb')

    const quorumRun = await runJoin(joinGraph('quorum', 1), 'join-quorum')
    expect(quorumRun.summary.outcome).toBe('failed')
    expect(quorumRun.summary.outputs.result ?? '').toContain('[from bb]')

    // Regression guard: an `all` join still skips when one upstream failed.
    const allRun = await runJoin(joinGraph('all'), 'join-all')
    expect(allRun.summary.outcome).toBe('failed')
    expect(startedNodes(allRun.records)).not.toContain('merge')
    expect(allRun.summary.outputs.result).toBe('')
  })

  it('aborts a child subworkflow when the parent run aborts', async () => {
    const child = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'child-flow',
      name: 'Child',
      entry: 'cstart',
      nodes: [
        { kind: 'input', id: 'cstart', params: [] },
        { kind: 'agent', id: 'work', agent: 'work', task: 'work' },
        { kind: 'output', id: 'cdone', value: '{{nodes.work}}' },
      ],
      edges: [
        { id: 'ce1', from: 'cstart', to: 'work', kind: 'flow' },
        { id: 'ce2', from: 'work', to: 'cdone', kind: 'flow' },
      ],
      outputs: { childResult: '{{nodes.cdone}}' },
    })
    const parent = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'parent-flow',
      name: 'Parent',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'subworkflow', id: 'sub', workflow: 'child-flow', inputs: {} },
        { kind: 'output', id: 'end', value: '{{nodes.sub}}' },
      ],
      edges: [
        { id: 'pe1', from: 'start', to: 'sub', kind: 'flow' },
        { id: 'pe2', from: 'sub', to: 'end', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.end}}' },
    })

    let childSignal: AbortSignal | undefined
    let markStarted: () => void = () => {}
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const runner: AgentRunner<Agent> = {
      start: async (input) => {
        childSignal = input.signal
        const result = new Promise<SubagentResult>((resolve) => {
          input.signal.addEventListener('abort', () => resolve({ output: [], stopReason: 'aborted' }), { once: true })
        })
        markStarted()
        return { childId: 'child-1', result }
      },
      disposeAll: async () => {},
    }
    const { services } = harness(runner, (id) => {
      if (id === 'child-flow') return child
      throw new Error(`unknown workflow "${id}"`)
    })
    const external = new AbortController()
    const handle = startWorkflowRun<Agent>({
      document: parent,
      inputs: {},
      runId: 'parent-flow',
      limits: LIMITS,
      services,
      signal: external.signal,
    })

    await started
    expect(childSignal?.aborted).toBe(false)
    external.abort()
    const summary = await handle.outcome
    expect(childSignal?.aborted).toBe(true)
    expect(summary.outcome).toBe('cancelled')
  })
})
