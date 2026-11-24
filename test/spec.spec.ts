import { describe, expect, it } from 'vitest'
import { AgentSpecSchema } from '../src/host/agents/spec.ts'

const MINIMAL = {
  id: 'reviewer',
  name: 'Reviewer',
  description: 'Reviews a diff for correctness.',
  prompt: 'You review diffs.',
}

describe('AgentSpecSchema', () => {
  it('applies the documented defaults', () => {
    expect(AgentSpecSchema.parse(MINIMAL)).toEqual({
      ...MINIMAL,
      provider: 'spawn',
      readOnly: true,
      timeoutMs: 600_000,
    })
  })

  it('passes optional activation fields through', () => {
    const spec = AgentSpecSchema.parse({
      ...MINIMAL,
      agentPreset: 'read-only-review',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
      maxTokens: 4_096,
      cwd: 'D:\\work\\repo',
      readOnly: false,
      timeoutMs: 1_000,
      outputSchema: { type: 'object' },
    })
    expect(spec.agentPreset).toBe('read-only-review')
    expect(spec.model).toBe('deepseek-chat')
    expect(spec.reasoningEffort).toBe('high')
    expect(spec.maxTokens).toBe(4_096)
    expect(spec.cwd).toBe('D:\\work\\repo')
    expect(spec.readOnly).toBe(false)
    expect(spec.timeoutMs).toBe(1_000)
    expect(spec.outputSchema).toEqual({ type: 'object' })
  })

  it.each([
    ['uppercase', 'Reviewer'],
    ['underscore', 're_viewer'],
    ['leading digit', '1reviewer'],
    ['too long', `r${'a'.repeat(41)}`],
  ])('rejects an id with %s', (_label, id) => {
    expect(() => AgentSpecSchema.parse({ ...MINIMAL, id })).toThrow()
  })

  it('rejects a missing prompt', () => {
    const { prompt: _prompt, ...withoutPrompt } = MINIMAL
    expect(() => AgentSpecSchema.parse(withoutPrompt)).toThrow()
  })

  it('rejects an unknown reasoning effort', () => {
    expect(() => AgentSpecSchema.parse({ ...MINIMAL, reasoningEffort: 'extreme' })).toThrow()
  })
})
