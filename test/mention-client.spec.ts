import { describe, expect, it } from 'vitest'
import {
  CATALOG_PROJECTION_KEY,
  catalogAgentsFromProjection,
  createMentionSource,
  mentionCandidates,
  XL_AGENT_CODEC,
  XL_AGENT_REFERENCE_SOURCE,
} from '../src/client/mention.ts'
import { createXlBuildProjection } from '../src/host/projection.ts'

const AGENTS = [
  { id: 'reviewer', name: 'Reviewer', description: 'Reviews a diff.' },
  { id: 'writer', name: 'Doc Writer', description: 'Writes docs.' },
]

/** A projection snapshot value in the shape the host publishes. */
const SNAPSHOT = { catalog: { agents: AGENTS, workflows: [{ id: 'release', name: 'Release' }] }, runs: [] }

describe('catalog projection read', () => {
  it('reads agents from a host-shaped value and rejects foreign values', () => {
    expect(catalogAgentsFromProjection(SNAPSHOT)).toEqual(AGENTS)
    expect(catalogAgentsFromProjection(undefined)).toEqual([])
    expect(catalogAgentsFromProjection({ catalog: { agents: [{ id: 1 }] } })).toEqual([])
  })

  it('stays bound to the host projection key and view width', () => {
    expect(createXlBuildProjection({ recentRuns: 1, wirePreviewBytes: 16 }).key).toBe(CATALOG_PROJECTION_KEY)
  })
})

describe('mention candidates', () => {
  it('returns every agent for an empty query, with the localized section', () => {
    expect(mentionCandidates(AGENTS, '', 'Subagents')).toEqual([
      { name: 'reviewer', label: 'Reviewer', description: 'Reviews a diff.', section: 'Subagents' },
      { name: 'writer', label: 'Doc Writer', description: 'Writes docs.', section: 'Subagents' },
    ])
  })

  it('matches the id and the display name case-insensitively', () => {
    expect(mentionCandidates(AGENTS, 'REV', 'S').map((candidate) => candidate.name)).toEqual(['reviewer'])
    expect(mentionCandidates(AGENTS, 'doc', 'S').map((candidate) => candidate.name)).toEqual(['writer'])
    expect(mentionCandidates(AGENTS, 'nothing', 'S')).toEqual([])
  })
})

describe('agent reference codec', () => {
  it('inserts the canonical token and the @id clipboard text', () => {
    expect(XL_AGENT_CODEC.clipboardText('reviewer')).toBe('@reviewer')
    return expect(XL_AGENT_CODEC.serialize('reviewer', new AbortController().signal))
      .resolves.toBe('<xl-agent id="reviewer" />')
  })

  it('refuses to serialize after cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(XL_AGENT_CODEC.serialize('reviewer', controller.signal)).rejects.toThrow('cancelled')
  })
})

describe('mention source', () => {
  const source = createMentionSource({ agentsFor: () => AGENTS, section: () => 'Subagents' })

  it('registers under @ with the xl-agent group', () => {
    expect(source.trigger).toBe('@')
    expect(source.name).toBe(XL_AGENT_REFERENCE_SOURCE)
    expect(source.order).toBe(20)
  })

  it('serves candidates for the picked session', async () => {
    const candidates = await source.candidates(
      { sessionId: 'session-1' as never },
      { query: 'rev', position: 'inline', drilled: false, signal: new AbortController().signal },
    )
    expect(candidates.map((candidate) => candidate.name)).toEqual(['reviewer'])
  })

  it('turns a pick into a labeled reference insert', () => {
    const outcome = source.onPick({
      candidate: { name: 'reviewer', label: 'Reviewer' },
      session: { sessionId: 'session-1' as never },
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 1 },
    })
    expect(outcome).toEqual({
      insert: {
        source: XL_AGENT_REFERENCE_SOURCE,
        ref: 'reviewer',
        label: 'Reviewer',
        clipboardText: '@reviewer',
      },
    })
  })
})
