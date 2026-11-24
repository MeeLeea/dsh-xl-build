import { describe, expect, it } from 'vitest'
import { collectAgentList, createAgentListTool } from '../src/host/agents/tool.ts'
import type { AgentRegistryEntry } from '../src/host/agents/registry.ts'

const VALID: AgentRegistryEntry = {
  status: 'valid',
  file: 'reviewer.yml',
  spec: {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews a diff for correctness.',
    prompt: 'SECRET PROMPT',
    provider: 'spawn',
    readOnly: true,
    timeoutMs: 600_000,
  },
}

const INVALID: AgentRegistryEntry = {
  status: 'invalid',
  file: 'broken.yaml',
  error: 'broken.yaml: id: Invalid string',
}

const registry = { listAgents: () => [VALID, INVALID] }

describe('xl_agent_list', () => {
  it('exposes ids, names, and descriptions but never the prompt', () => {
    const value = collectAgentList(registry)
    expect(value.agents).toEqual([{
      id: 'reviewer',
      name: 'Reviewer',
      description: 'Reviews a diff for correctness.',
    }])
    expect(JSON.stringify(value)).not.toContain('SECRET PROMPT')
  })

  it('reports invalid definition files with their error', () => {
    expect(collectAgentList(registry).invalid).toEqual([
      { file: 'broken.yaml', error: 'broken.yaml: id: Invalid string' },
    ])
  })

  it('is registered under the documented tool name', () => {
    const tool = createAgentListTool(registry)
    expect(tool.name).toBe('xl_agent_list')
    expect(tool.parameters).toEqual({ type: 'object', properties: {} })
    expect(tool.output.schema).toMatchObject({ type: 'object', additionalProperties: false })
  })

  it('renders the listing as text', () => {
    const tool = createAgentListTool(registry)
    const blocks = tool.output.render({}, collectAgentList(registry))
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
    expect(text).toContain('reviewer: Reviewer')
    expect(text).toContain('broken.yaml')
    expect(text).not.toContain('SECRET PROMPT')
  })
})
