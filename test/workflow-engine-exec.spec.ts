/**
 * Execution-level workflow engine tests.
 *
 * The pure-function specs cover each decision in isolation; these drive a real
 * `startWorkflowRun` through a recording stub `AgentRunner` so the runtime
 * wiring of joins, loops, routers, error edges, and subworkflows is observed:
 * which nodes execute, how often, and what each one's output carries.
 */
import { describe, expect, it, vi } from 'vitest'
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
  type AgentAskAnswer,
  type AgentAskQuestion,
  type WorkflowRunLimits,
  type WorkflowRunServices,
} from '../src/host/workflow/run.ts'
import { XL_EVENTS, type XlEventType, type NodeDeltaPayload } from '../src/host/events.ts'
import type { NodeProgress } from '../src/host/workflow/run.ts'

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



function deltaTexts(records: readonly JournalRecord[], nodeId: string): string[] {
  return records
    .filter((record) => record.name === XL_EVENTS.nodeDelta && (record.payload as { nodeId: string }).nodeId === nodeId)
    .map((record) => (record.payload as NodeDeltaPayload).text)
}

/**
 * Services over an in-memory journal: agents resolve through the schema, so
 * each agent node's `agent` id is its node id, records land in an array, and
 * runs do not touch disk.
 * @param runner - the stub agent runner under test.
 * @param loadSubworkflow - child-document resolver; absent rejects every id.
 * @returns the run services and the captured records.
 */
function harness(
  runner: AgentRunner<Agent>,
  loadSubworkflow?: (id: string) => WorkflowDocument,
  readNodeProgress?: (childId: string) => NodeProgress | undefined,
  askUser?: WorkflowRunServices<Agent>['askUser'],
  structuredAgents?: readonly string[],
): {
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
      description: `stub ${id}`,
      prompt: 'You are a stub.',
      // Structured-output agents return the schema-validated object as the
      // node output; ask tests need that to surface status/ask payloads.
      ...(structuredAgents?.includes(id) !== true ? {} : { outputSchema: { type: 'object', additionalProperties: true } }),
    }),
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
    ...(readNodeProgress !== undefined ? { readNodeProgress } : {}),
    ...(askUser !== undefined ? { askUser } : {}),
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

  it('streams live progress snapshots and the final output as node-delta records', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'progress-flow',
      name: 'Progress',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'agent', id: 'work', agent: 'work', task: 'work' },
        { kind: 'output', id: 'done', value: '{{nodes.work}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
        { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done}}' },
    })
    // The child settles only when the test releases it, so the progress
    // poll ticks while the node is running.
    const pending: Array<() => void> = []
    const runner: AgentRunner<Agent> = {
      start: async (input) => ({
        childId: `child-${input.spec.id}`,
        result: new Promise<SubagentResult>((resolve) => {
          pending.push(() => resolve(completedResult('final answer')))
        }),
      }),
      disposeAll: async () => {},
    }
    const reads: string[] = []
    const readNodeProgress = (childId: string): NodeProgress => {
      reads.push(childId)
      return { steps: 2, llmMs: 4200, draft: 'streaming' }
    }
    const { services, records } = harness(runner, undefined, readNodeProgress)
    const handle = startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'progress',
      limits: { ...LIMITS, progressIntervalMs: 5 },
      services,
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((id) => id === 'child-work')).toBe(true)
    for (const release of pending) release()
    const summary = await handle.outcome

    expect(summary.outcome).toBe('completed')
    // Identical snapshots dedupe to one live record; the final output replaces it.
    expect(deltaTexts(records, 'work')).toEqual(['2 steps · 4s\nstreaming', 'final answer'])
    const names = records.map((record) => record.name)
    expect(names.indexOf(XL_EVENTS.nodeDelta)).toBeLessThan(names.lastIndexOf(XL_EVENTS.nodeEnd))
  })

  it('records the final output preview without a progress source', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'final-only-flow',
      name: 'FinalOnly',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'agent', id: 'work', agent: 'work', task: 'work' },
        { kind: 'output', id: 'done', value: '{{nodes.work}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
        { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done}}' },
    })
    const calls: StubCall[] = []
    const { services, records } = harness(recordingRunner(calls))
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'final-only',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    expect(deltaTexts(records, 'work')).toEqual(['result-work'])
  })

  it('relays ask questions to the initiator and re-runs the node with the answers', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'ask-flow',
      name: 'Ask',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'agent', id: 'work', agent: 'work', task: 'work' },
        { kind: 'output', id: 'done', value: '{{nodes.work}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
        { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done}}' },
    })
    const prompts: string[] = []
    const runner: AgentRunner<Agent> = {
      start: async (input) => {
        prompts.push(input.task)
        const asks = prompts.length === 1
        return {
          childId: `child-${input.spec.id}-${prompts.length}`,
          result: Promise.resolve(asks
            ? { output: [], stopReason: 'completed', structured: { status: 'ask', ask: { questions: [
              { id: 'root', question: 'resourcesRoot 在哪里？', header: '细节', options: [{ label: 'D:/skills/sc_model' }] },
            ] } } }
            : { output: [], stopReason: 'completed', structured: { status: 'done', result: 'settled' } }),
        }
      },
      disposeAll: async () => {},
    }
    const asked: AgentAskQuestion[][] = []
    const askUser = vi.fn(async (questions: readonly AgentAskQuestion[]): Promise<readonly AgentAskAnswer[]> => {
      asked.push([...questions])
      return [{ id: 'root', selected: ['D:/skills/sc_model'], custom: '直接用这个' }]
    })
    const { services, records } = harness(runner, undefined, undefined, askUser, ['work'])
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'ask-round',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    expect(summary.outputs.result).toContain('settled')
    // The relay fired once, with the normalized question and options.
    expect(asked).toEqual([[{
      id: 'root',
      question: 'resourcesRoot 在哪里？',
      header: '细节',
      options: [{ label: 'D:/skills/sc_model' }],
    }]])
    // The re-run prompt carries the answer block.
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('用户已答复上一轮 ask 的提问')
    expect(prompts[1]).toContain('Q: resourcesRoot 在哪里？')
    expect(prompts[1]).toContain('A: D:/skills/sc_model；（补充）直接用这个')
    // The waiting preview precedes the settled output preview.
    expect(deltaTexts(records, 'work')).toEqual(['等待用户答复: resourcesRoot 在哪里？', JSON.stringify({ status: 'done', result: 'settled' }, null, 2)])
  })

  it('relays xl-ask text blocks from schema-less agents and re-runs with the answers', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'text-ask-flow',
      name: 'TextAsk',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'agent', id: 'work', agent: 'work', task: 'work' },
        { kind: 'output', id: 'done', value: '{{nodes.work}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
        { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done}}' },
    })
    const askBlock = '```xl-ask\n{"questions": [{"id": "root", "question": "要问的问题？", "header": "细节", "options": [{"label": "D:/skills/sc_model"}]}]}\n' + '```'
    const prompts: string[] = []
    const runner: AgentRunner<Agent> = {
      start: async (input) => {
        prompts.push(input.task)
        return {
          childId: `child-${input.spec.id}-${prompts.length}`,
          result: Promise.resolve(completedResult(prompts.length === 1 ? askBlock : 'settled-text')),
        }
      },
      disposeAll: async () => {},
    }
    const asked: AgentAskQuestion[][] = []
    const askUser = vi.fn(async (questions: readonly AgentAskQuestion[]): Promise<readonly AgentAskAnswer[]> => {
      asked.push([...questions])
      return [{ id: 'root', selected: ['D:/skills/sc_model'], custom: '直接用这个' }]
    })
    const { services, records } = harness(runner, undefined, undefined, askUser)
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'text-ask',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    expect(summary.outputs.result).toContain('settled-text')
    // The schema-less task carries the protocol teaching; the block never settles.
    expect(prompts[0]).toContain('ask 通道')
    expect(prompts[0]).toContain('```xl-ask')
    expect(summary.outputs.result).not.toContain('xl-ask')
    // The relay fired once, with the normalized question and options.
    expect(asked).toEqual([[{
      id: 'root',
      question: '要问的问题？',
      header: '细节',
      options: [{ label: 'D:/skills/sc_model' }],
    }]])
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('用户已答复上一轮 ask 的提问')
    expect(prompts[1]).toContain('Q: 要问的问题？')
    expect(prompts[1]).toContain('A: D:/skills/sc_model；（补充）直接用这个')
    // The waiting preview precedes the cleaned settled text preview.
    expect(deltaTexts(records, 'work')).toEqual(['等待用户答复: 要问的问题？', 'settled-text'])
  })

  it('strips the xl-ask block after exhausting the ask round cap', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'ask-cap-flow',
      name: 'AskCap',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'agent', id: 'work', agent: 'work', task: 'work' },
        { kind: 'output', id: 'done', value: '{{nodes.work}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
        { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done}}' },
    })
    const askText = '前置说明\n' + '```xl-ask\n{"questions": [{"id": "q", "question": "还缺什么？"}]}\n' + '```' + '\n收尾'
    const prompts: string[] = []
    const runner: AgentRunner<Agent> = {
      start: async (input) => {
        prompts.push(input.task)
        return { childId: 'child-' + prompts.length, result: Promise.resolve(completedResult(askText)) }
      },
      disposeAll: async () => {},
    }
    const askUser = vi.fn(async (questions: readonly AgentAskQuestion[]): Promise<readonly AgentAskAnswer[]> => {
      return [{ id: 'q', selected: ['不知道'], custom: '' }]
    })
    const { services, records } = harness(runner, undefined, undefined, askUser)
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'ask-cap',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    // Round cap (3): three relays, the fourth activation settles the text minus the block.
    expect(askUser).toHaveBeenCalledTimes(3)
    expect(prompts).toHaveLength(4)
    expect(summary.outputs.result).toBe('前置说明\n\n收尾')
    expect(summary.outputs.result).not.toContain('xl-ask')
    // Four relayed/capped activations each preview the waiting line (final
    // emits bypass dedupe); the exhausted settle appends the cleaned text.
    expect(deltaTexts(records, 'work')).toEqual([
      '等待用户答复: 还缺什么？',
      '等待用户答复: 还缺什么？',
      '等待用户答复: 还缺什么？',
      '等待用户答复: 还缺什么？',
      '前置说明\n\n收尾',
    ])
  })

  it('omits the text ask protocol when the host exposes no askUser port', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'no-port-flow',
      name: 'NoPort',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'agent', id: 'work', agent: 'work', task: 'work' },
        { kind: 'output', id: 'done', value: '{{nodes.work}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
        { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done}}' },
    })
    const calls: StubCall[] = []
    const { services } = harness(recordingRunner(calls))
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'no-port',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    expect(summary.outputs.result).toContain('result-work')
    expect(calls[0]?.prompt).not.toContain('ask 通道')
    expect(calls[0]?.prompt).not.toContain('xl-ask')
  })

  it('passes ask-shaped outputs through unchanged without an askUser port', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'passthrough-flow',
      name: 'PassThrough',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'agent', id: 'work', agent: 'work', task: 'work' },
        { kind: 'output', id: 'done', value: '{{nodes.work}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
        { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done}}' },
    })
    const calls: StubCall[] = []
    const runner = recordingRunner(calls, () => ({
      output: [],
      stopReason: 'completed',
      structured: { status: 'ask', ask: { prompt: '缺少 need_driver', choices: [{ id: 'TRUE', label: '是' }] } },
    }))
    const { services, records } = harness(runner, undefined, undefined, undefined, ['work'])
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'passthrough',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    // No relay, one activation, the ask output reaches the router intact.
    expect(calls).toHaveLength(1)
    expect(summary.outputs.result).toContain('ask')
    expect(deltaTexts(records, 'work')).toHaveLength(1)
  })

  it('stops re-running an ask node after the round cap and passes the output through', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'ask-cap-flow',
      name: 'AskCap',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'agent', id: 'work', agent: 'work', task: 'work' },
        { kind: 'output', id: 'done', value: '{{nodes.work}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
        { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done}}' },
    })
    let activations = 0
    const runner: AgentRunner<Agent> = {
      start: async (input) => {
        activations += 1
        return {
          childId: `child-${activations}`,
          // Always asks again, so only the round cap can end the loop.
          result: Promise.resolve({ output: [], stopReason: 'completed', structured: { status: 'ask', ask: { prompt: '还是缺参数' } } }),
        }
      },
      disposeAll: async () => {},
    }
    const askUser = vi.fn(async (): Promise<readonly AgentAskAnswer[]> => [])
    const { services, records } = harness(runner, undefined, undefined, askUser, ['work'])
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'ask-cap',
      limits: { ...LIMITS, maxAskRounds: 1 },
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    // Initial activation + one re-run after the first relay; the cap then
    // passes the still-asking output through instead of relaying again.
    expect(activations).toBe(2)
    expect(askUser).toHaveBeenCalledTimes(1)
    expect(summary.outputs.result).toContain('ask')
  })

  it('re-runs legacy prompt/choices asks and normalizes their questions', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'legacy-ask-flow',
      name: 'LegacyAsk',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'agent', id: 'work', agent: 'work', task: 'work' },
        { kind: 'output', id: 'done', value: '{{nodes.work}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'work', kind: 'flow' },
        { id: 'e2', from: 'work', to: 'done', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.done}}' },
    })
    const prompts: string[] = []
    const runner: AgentRunner<Agent> = {
      start: async (input) => {
        prompts.push(input.task)
        const asks = prompts.length === 1
        return {
          childId: `child-${prompts.length}`,
          result: Promise.resolve(asks
            ? { output: [], stopReason: 'completed', structured: { status: 'ask', ask: { prompt: 'need_driver 生成 driver 吗？', choices: [{ id: 'TRUE', label: '生成' }, { id: 'FALSE', label: '不生成' }] } } }
            : { output: [], stopReason: 'completed', structured: { status: 'done', result: 'legacy settled' } }),
        }
      },
      disposeAll: async () => {},
    }
    const asked: AgentAskQuestion[][] = []
    const askUser = vi.fn(async (questions: readonly AgentAskQuestion[]): Promise<readonly AgentAskAnswer[]> => {
      asked.push([...questions])
      return [{ id: 'ask', selected: ['生成'] }]
    })
    const { services } = harness(runner, undefined, undefined, askUser, ['work'])
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'legacy-ask',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    expect(asked).toEqual([[{ id: 'ask', question: 'need_driver 生成 driver 吗？', options: [{ label: '生成' }, { label: '不生成' }] }]])
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('A: 生成')
    expect(summary.outputs.result).toContain('legacy settled')
  })

  it('runs an ask node: renders question templates, waits for the user, and routes on the answers', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'ask-node-flow',
      name: 'Ask node flow',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [{ name: 'topic', required: true }] },
        {
          kind: 'ask',
          id: 'confirm',
          questions: [
            {
              id: 'pack',
              question: '针对 {{input.topic}}，需要打包产物吗?',
              header: '打包',
              options: [{ label: 'yes' }, { label: 'no', description: '只生成工程' }],
            },
            { question: '还有其他要求吗?' },
          ],
        },
        {
          kind: 'router',
          id: 'pack-router',
          branches: [{ when: '{"==": [{"var": "nodes.confirm.selected.pack"}, "yes"]}', to: 'yes-out' }],
          else: 'no-out',
        },
        { kind: 'output', id: 'yes-out', value: 'chosen: yes' },
        { kind: 'output', id: 'no-out', value: 'chosen: no' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'confirm', kind: 'flow' },
        { id: 'e2', from: 'confirm', to: 'pack-router', kind: 'flow' },
        { id: 'e3', from: 'pack-router', to: 'yes-out', kind: 'branch' },
        { id: 'e4', from: 'pack-router', to: 'no-out', kind: 'branch' },
      ],
      outputs: { result: '{{nodes.yes-out}}', skipped: '{{nodes.no-out}}' },
    })
    const asked: AgentAskQuestion[][] = []
    const askUser = async (questions: readonly AgentAskQuestion[]): Promise<readonly AgentAskAnswer[]> => {
      asked.push([...questions])
      return [
        { id: 'pack', selected: ['yes'] },
        { id: 'q2', selected: [], custom: '带上日志' },
      ]
    }
    const { services, records } = harness(recordingRunner([]), undefined, undefined, askUser)
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: { topic: 'fifo 芯粒' },
      runId: 'ask-node',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('completed')
    // The question templates render against the frame; ids default to q2.
    expect(asked).toEqual([[
      {
        id: 'pack',
        question: '针对 fifo 芯粒，需要打包产物吗?',
        header: '打包',
        options: [{ label: 'yes' }, { label: 'no', description: '只生成工程' }],
      },
      { id: 'q2', question: '还有其他要求吗?' },
    ]])
    // The router branched on the selected map; the unchosen output is empty.
    expect(summary.outputs.result).toBe('chosen: yes')
    expect(summary.outputs.skipped).toBe('')
    // The node's preview waits, then settles to the readable answer block.
    expect(deltaTexts(records, 'confirm')[0]).toBe(
      `等待用户答复: 针对 fifo 芯粒，需要打包产物吗?
等待用户答复: 还有其他要求吗?`,
    )
    expect(deltaTexts(records, 'confirm')[1]).toContain('Q: 针对 fifo 芯粒，需要打包产物吗?')
    expect(deltaTexts(records, 'confirm')[1]).toContain('A: yes')
    expect(deltaTexts(records, 'confirm')[1]).toContain('（补充）带上日志')
    // The node settled completed; the router branch above already proves
    // the selected map the structured output carries.
    const ended = records.find((record) => record.name === XL_EVENTS.nodeEnd
      && (record.payload as { nodeId: string }).nodeId === 'confirm')
    expect((ended?.payload as { status: string }).status).toBe('completed')
  })

  it('fails an ask node deterministically when the host has no ask channel', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'ask-bare',
      name: 'Ask bare',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'ask', id: 'confirm', questions: [{ question: '继续吗?' }] },
        { kind: 'output', id: 'out', value: '{{nodes.confirm.text}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'confirm', kind: 'flow' },
        { id: 'e2', from: 'confirm', to: 'out', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.out}}' },
    })
    const { services, records } = harness(recordingRunner([]))
    const summary = await startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'ask-bare',
      limits: LIMITS,
      services,
    }).outcome

    expect(summary.outcome).toBe('failed')
    expect(summary.failures.some((failure) => failure.message.includes('ask node "confirm" failed'))).toBe(true)
    const errored = records.find((record) => record.name === XL_EVENTS.nodeError
      && (record.payload as { nodeId: string }).nodeId === 'confirm')
    expect((errored?.payload as { message: string }).message).toContain('ask node "confirm" has no ask channel')
    const ended = records.find((record) => record.name === XL_EVENTS.nodeEnd
      && (record.payload as { nodeId: string }).nodeId === 'confirm')
    expect((ended?.payload as { status: string }).status).toBe('failed')
  })

  it('holds ready nodes while an ask round waits, then resumes after the answers', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'ask-hold',
      name: 'Ask hold',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'ask', id: 'confirm', questions: [{ id: 'go', question: '继续吗?', options: [{ label: 'go' }] }] },
        { kind: 'agent', id: 'side', agent: 'side', task: 'side' },
        { kind: 'agent', id: 'after', agent: 'after', task: 'after' },
        { kind: 'join', id: 'merge', strategy: 'all' },
        { kind: 'output', id: 'out', value: '{{nodes.merge}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'confirm', kind: 'fan-out' },
        { id: 'e2', from: 'start', to: 'side', kind: 'fan-out' },
        { id: 'e3', from: 'side', to: 'after', kind: 'flow' },
        { id: 'e4', from: 'confirm', to: 'merge', kind: 'fan-in' },
        { id: 'e5', from: 'after', to: 'merge', kind: 'fan-in' },
        { id: 'e6', from: 'merge', to: 'out', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.out}}' },
    })
    // side settles only when the test releases it; after answers immediately
    // once it is allowed to start.
    const sideRelease: Array<() => void> = []
    const runner: AgentRunner<Agent> = {
      start: async (input) => ({
        childId: 'child-' + input.spec.id,
        result: input.spec.id === 'side'
          ? new Promise<SubagentResult>((resolve) => { sideRelease.push(() => resolve(completedResult('side-done'))) })
          : Promise.resolve(completedResult('after-done')),
      }),
      disposeAll: async () => {},
    }
    let resolveAsk: (answers: readonly AgentAskAnswer[]) => void = () => {}
    let askedCount = 0
    const askUser = (_questions: readonly AgentAskQuestion[]): Promise<readonly AgentAskAnswer[]> =>
      new Promise((resolve) => { askedCount += 1; resolveAsk = resolve })
    const { services, records } = harness(runner, undefined, undefined, askUser)
    const handle = startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'ask-hold',
      limits: LIMITS,
      services,
    })

    // The ask round opens first; side settles while it is still waiting.
    await vi.waitFor(() => expect(askedCount).toBeGreaterThan(0))
    sideRelease[0]?.()
    await vi.waitFor(() => expect(records.some((record) => record.name === XL_EVENTS.nodeEnd
      && (record.payload as { nodeId: string }).nodeId === 'side')).toBe(true))
    // Give the scheduler real time to (wrongly) start after.
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(startedNodes(records)).not.toContain('after')
    expect(startedNodes(records)).toContain('confirm')

    // The answers arrive; the held branch resumes and the join settles.
    resolveAsk([{ id: 'go', selected: ['go'] }])
    const summary = await handle.outcome
    expect(summary.outcome).toBe('completed')
    expect(startedNodes(records)).toContain('after')
    expect(summary.outputs.result).toContain('after-done')
  })

  it('schedules siblings while an ask waits when pauseWhileAsking is false', async () => {
    const document = parseWorkflowDocument({
      schemaVersion: 1,
      id: 'ask-parallel',
      name: 'Ask parallel',
      entry: 'start',
      nodes: [
        { kind: 'input', id: 'start', params: [] },
        { kind: 'ask', id: 'confirm', questions: [{ id: 'go', question: '继续吗?' }] },
        { kind: 'agent', id: 'side', agent: 'side', task: 'side' },
        { kind: 'agent', id: 'after', agent: 'after', task: 'after' },
        { kind: 'join', id: 'merge', strategy: 'all' },
        { kind: 'output', id: 'out', value: '{{nodes.merge}}' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'confirm', kind: 'fan-out' },
        { id: 'e2', from: 'start', to: 'side', kind: 'fan-out' },
        { id: 'e3', from: 'side', to: 'after', kind: 'flow' },
        { id: 'e4', from: 'confirm', to: 'merge', kind: 'fan-in' },
        { id: 'e5', from: 'after', to: 'merge', kind: 'fan-in' },
        { id: 'e6', from: 'merge', to: 'out', kind: 'flow' },
      ],
      outputs: { result: '{{nodes.out}}' },
    })
    let resolveAsk: (answers: readonly AgentAskAnswer[]) => void = () => {}
    const askUser = (_questions: readonly AgentAskQuestion[]): Promise<readonly AgentAskAnswer[]> =>
      new Promise((resolve) => { resolveAsk = resolve })
    const { services, records } = harness(recordingRunner([]), undefined, undefined, askUser)
    const handle = startWorkflowRun<Agent>({
      document,
      inputs: {},
      runId: 'ask-parallel',
      limits: { ...LIMITS, pauseWhileAsking: false },
      services,
    })

    // after is allowed to start while the ask still waits.
    await vi.waitFor(() => expect(startedNodes(records)).toContain('after'))
    expect(records.some((record) => record.name === XL_EVENTS.nodeEnd
      && (record.payload as { nodeId: string }).nodeId === 'confirm')).toBe(false)

    resolveAsk([{ id: 'go', selected: [] }])
    const summary = await handle.outcome
    expect(summary.outcome).toBe('completed')
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
