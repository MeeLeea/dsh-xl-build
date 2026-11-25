/** Projection parsing degrades per run and per catalog instead of blanking the panel. */
import { describe, expect, it } from 'vitest'
import { parseXlBuildView } from '../src/client/wire.ts'

/** A run that satisfies the wire schema with no members. */
const validRun = {
  runId: 'run-1',
  workflowId: 'chain',
  workflowHash: 'h',
  status: 'completed',
  nodes: [],
  edges: [],
  artifacts: [],
}

const catalog = {
  agents: [{ id: 'reviewer', name: 'Reviewer', description: 'Reviews.' }],
  workflows: [{ id: 'chain', name: 'Chain', mermaid: 'graph TD' }],
}

describe('parseXlBuildView', () => {
  it('keeps valid runs, drops a malformed one, and preserves order', () => {
    const view = parseXlBuildView({
      catalog,
      runs: [validRun, { runId: 42 }, { ...validRun, runId: 'run-2' }],
    })
    expect(view?.runs.map((run) => run.runId)).toEqual(['run-1', 'run-2'])
  })

  it('falls back to an empty catalog while keeping valid runs', () => {
    const view = parseXlBuildView({ catalog: { agents: 'nope' }, runs: [validRun] })
    expect(view?.catalog).toEqual({ agents: [], workflows: [] })
    expect(view?.runs).toHaveLength(1)
  })

  it('treats a non-array runs value as no runs', () => {
    expect(parseXlBuildView({ catalog, runs: 'x' })?.runs).toEqual([])
  })

  it('returns undefined for a non-object or an object with neither key', () => {
    expect(parseXlBuildView(undefined)).toBeUndefined()
    expect(parseXlBuildView(null)).toBeUndefined()
    expect(parseXlBuildView('text')).toBeUndefined()
    expect(parseXlBuildView({ other: true })).toBeUndefined()
  })
})
