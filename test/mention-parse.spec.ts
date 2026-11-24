import { describe, expect, it } from 'vitest'
import { parseMentions } from '../src/host/agents/mention.ts'

const AGENTS = [
  { id: 'reviewer', name: 'Reviewer' },
  { id: 'code-reviewer', name: 'Code Reviewer' },
]

describe('parseMentions', () => {
  it('parses the canonical token and slices the following task', () => {
    const [mention] = parseMentions('please <xl-agent id="reviewer" /> check the diff', AGENTS)
    expect(mention).toMatchObject({
      segmentIndex: 0,
      raw: '<xl-agent id="reviewer" />',
      start: 7,
      end: 33,
      task: 'check the diff',
      resolution: { kind: 'resolved', agentId: 'reviewer' },
    })
  })

  it('accepts a token whose whitespace was dropped', () => {
    const [mention] = parseMentions('<xl-agent id="reviewer"/>', AGENTS)
    expect(mention?.resolution).toEqual({ kind: 'resolved', agentId: 'reviewer' })
    expect(mention?.task).toBe('')
  })

  it('resolves a hand-typed id and a hand-typed display name', () => {
    const [byId, byName] = parseMentions('@reviewer do this and @Code Reviewer do that', AGENTS)
    expect(byId?.resolution).toEqual({ kind: 'resolved', agentId: 'reviewer' })
    expect(byId?.task).toBe('do this and')
    expect(byName?.resolution).toEqual({ kind: 'resolved', agentId: 'code-reviewer' })
    expect(byName?.task).toBe('do that')
  })

  it('numbers every mention in appearance order and splits tasks between them', () => {
    const mentions = parseMentions('<xl-agent id="reviewer" /> first @code-reviewer second', AGENTS)
    expect(mentions.map((mention) => mention.segmentIndex)).toEqual([0, 1])
    expect(mentions.map((mention) => mention.task)).toEqual(['first', 'second'])
    expect(mentions[1]?.resolution).toEqual({ kind: 'resolved', agentId: 'code-reviewer' })
  })

  it('keeps a mid-sentence mention with no following text', () => {
    const [mention] = parseMentions('review this <xl-agent id="reviewer" />', AGENTS)
    expect(mention?.task).toBe('')
    expect(mention?.start).toBe(12)
  })

  it('reports an unknown token target as unresolved without dropping it', () => {
    const [mention] = parseMentions('<xl-agent id="missing" /> do it', AGENTS)
    expect(mention?.resolution).toEqual({ kind: 'unresolved', reason: 'unknown-agent' })
    expect(mention?.raw).toBe('<xl-agent id="missing" />')
    expect(mention?.task).toBe('do it')
  })

  it('reports an ambiguous display name as unresolved', () => {
    const agents = [
      { id: 'reviewer-a', name: 'Reviewer' },
      { id: 'reviewer-b', name: 'Reviewer' },
    ]
    const [mention] = parseMentions('@Reviewer go', agents)
    expect(mention?.resolution).toEqual({ kind: 'unresolved', reason: 'ambiguous-label' })
  })

  it('ignores an @ inside an address and text with no mention', () => {
    expect(parseMentions('mail user@example.com about it', AGENTS)).toEqual([])
    expect(parseMentions('nothing to see here', AGENTS)).toEqual([])
  })

  it('does not treat a token-looking string inside a token as a second mention', () => {
    const mentions = parseMentions('<xl-agent id="reviewer" /> done', AGENTS)
    expect(mentions).toHaveLength(1)
  })
})
