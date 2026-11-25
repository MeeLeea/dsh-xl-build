import { describe, expect, it } from 'vitest'
import { createActivationGate } from '../src/host/agents/gate.ts'
import {
  buildActivationRequest,
  buildAgentOptions,
  buildPromptBlocks,
  createAgentRunner,
  READ_ONLY_PREFIX,
} from '../src/host/agents/run.ts'
import type { SubagentActivationSpec, SubagentStartPort } from '../src/host/agents/run.ts'
import { AgentSpecSchema } from '../src/host/agents/spec.ts'
import { collectAgentList, listAgentIds, unknownAgentMessage } from '../src/host/agents/tool.ts'

const SPEC = AgentSpecSchema.parse({
  id: 'reviewer',
  name: 'Reviewer',
  description: 'Reviews a diff.',
  prompt: 'You review diffs.',
})

/** Poll until a predicate holds so timing assertions need no fixed sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('waitFor timed out')
}

/** Stub subagent port recording every activation spec it receives; disposal settles the result. */
function stubPort() {
  const specs: SubagentActivationSpec<string>[] = []
  let disposed = 0
  const port: SubagentStartPort<string> = {
    startActivation: async (spec) => {
      specs.push(spec)
      let settle: () => void = () => {}
      const result = new Promise<void>((resolve) => { settle = resolve })
      return {
        childId: `child-${specs.length}`,
        dispose: async () => {
          disposed += 1
          settle()
        },
        result,
      }
    },
  }
  return { port, specs, disposedCount: () => disposed }
}

describe('prompt and option mapping', () => {
  it('prefixes the read-only declaration onto the role prompt and keeps the task as its own block', () => {
    const blocks = buildPromptBlocks(SPEC, 'Review this diff.')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({ type: 'text', text: `${READ_ONLY_PREFIX}\n\n${SPEC.prompt}` })
    expect(blocks[1]).toEqual({ type: 'text', text: 'Review this diff.' })
  })

  it('delivers the bare role prompt and the task when readOnly is off', () => {
    const spec = AgentSpecSchema.parse({ ...SPEC, readOnly: false })
    expect(buildPromptBlocks(spec, 'Review this diff.')).toEqual([
      { type: 'text', text: 'You review diffs.' },
      { type: 'text', text: 'Review this diff.' },
    ])
  })

  it('maps only model, reasoning effort, and max tokens onto agent options', () => {
    expect(buildAgentOptions(SPEC)).toBeUndefined()
    const spec = AgentSpecSchema.parse({
      ...SPEC,
      model: 'deepseek-chat',
      reasoningEffort: 'high',
      maxTokens: 4_096,
    })
    expect(buildAgentOptions(spec)).toEqual({
      model: 'deepseek-chat',
      reasoningEffort: 'high',
      maxTokens: 4_096,
    })
  })

  it('assembles a request with no tool-filter key and passes the preset through', () => {
    const spec = AgentSpecSchema.parse({
      ...SPEC,
      agentPreset: 'read-only-review',
      cwd: 'D:\\work\\repo',
    })
    const request = buildActivationRequest(spec, 'task text', 'parent-session', spec.cwd)
    expect(Object.keys(request).sort()).toEqual(['agentPreset', 'cwd', 'parent', 'prompt'])
    expect(request.agentPreset).toBe('read-only-review')
    expect(request.cwd).toBe('D:\\work\\repo')
    expect(request.parent).toBe('parent-session')
    expect('toolFilter' in request).toBe(false)
  })

  it('rejects an output schema outside the enforced JSON Schema subset', () => {
    const spec = AgentSpecSchema.parse({ ...SPEC, outputSchema: { type: 'array' } })
    expect(() => buildActivationRequest(spec, 'task', 'parent', undefined)).toThrow()
  })
})

describe('unknown agent diagnostics', () => {
  const entries = [
    { status: 'valid' as const, file: 'a.yml', spec: SPEC },
    { status: 'invalid' as const, file: 'bad.yml', error: 'bad.yml: id: Invalid string' },
  ]

  it('lists the available ids and ignores invalid files', () => {
    expect(listAgentIds({ listAgents: () => entries })).toEqual(['reviewer'])
    expect(unknownAgentMessage('missing', ['reviewer', 'writer']))
      .toBe('Unknown agent "missing". Available agents: reviewer, writer.')
    expect(collectAgentList({ listAgents: () => entries }).invalid).toHaveLength(1)
  })

  it('truncates a long catalog after twenty ids', () => {
    const ids = Array.from({ length: 23 }, (_value, index) => `agent-${index}`)
    const message = unknownAgentMessage('missing', ids)
    expect(message).toContain('agent-19')
    expect(message).not.toContain('agent-20')
    expect(message).toContain('and 3 more')
  })

  it('names an empty catalog', () => {
    expect(unknownAgentMessage('missing', [])).toBe('Unknown agent "missing". Available agents: (none).')
  })
})

describe('agent runner', () => {
  it('uses parent delivery and returns the child id without awaiting the result', async () => {
    const { port, specs } = stubPort()
    const runner = createAgentRunner(port, createActivationGate(4))
    const started = await runner.start({
      spec: SPEC,
      task: 'Review this diff.',
      parent: 'parent-session',
      signal: new AbortController().signal,
      delivery: 'parent',
    })
    expect(started.childId).toBe('child-1')
    expect(typeof started.result?.then).toBe('function')
    expect(specs[0]).toMatchObject({
      provider: 'spawn',
      label: 'Reviewer',
      delivery: 'parent',
    })
    expect(specs[0]?.request.parent).toBe('parent-session')
    expect(specs[0]?.request.prompt[0]).toMatchObject({ type: 'text' })
    expect(Object.keys(specs[0]?.request ?? {}).sort()).toEqual(['parent', 'prompt'])
  })

  it('disposes the activation when its own timeout elapses', async () => {
    const { port, disposedCount } = stubPort()
    const runner = createAgentRunner(port, createActivationGate(4))
    const spec = AgentSpecSchema.parse({ ...SPEC, timeoutMs: 10 })
    await runner.start({
      spec,
      task: 'Review this diff.',
      parent: 'parent-session',
      signal: new AbortController().signal,
      delivery: 'parent',
    })
    await waitFor(() => disposedCount() > 0)
    expect(disposedCount()).toBe(1)
  })

  it('disposes every unsettled activation on disposeAll', async () => {
    const { port, disposedCount } = stubPort()
    const runner = createAgentRunner(port, createActivationGate(4))
    const signal = new AbortController().signal
    await runner.start({ spec: SPEC, task: 'first', parent: 'p', signal, delivery: 'parent' })
    await runner.start({ spec: SPEC, task: 'second', parent: 'p', signal, delivery: 'parent' })
    await runner.disposeAll()
    expect(disposedCount()).toBe(2)
  })

  it('queues delegations past the conversation limit', async () => {
    const { port, specs } = stubPort()
    const runner = createAgentRunner(port, createActivationGate(1))
    const signal = new AbortController().signal
    await runner.start({ spec: SPEC, task: 'first', parent: 'p', signal, delivery: 'parent' })
    const second = runner.start({ spec: SPEC, task: 'second', parent: 'p', signal, delivery: 'parent' })
    expect(specs).toHaveLength(1)
    await runner.disposeAll()
    await expect(second).resolves.toMatchObject({ childId: 'child-2' })
  })
})
