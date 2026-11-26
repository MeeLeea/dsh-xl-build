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

  it('defaults a legacy catalog workflow to an empty structural graph and parses a structural one', () => {
    // A catalog persisted before the structural projection exists: nodes and
    // edges default to [] so the cached view still validates.
    const legacy = parseXlBuildView({ catalog, runs: [validRun] })
    expect(legacy?.catalog.workflows[0]?.nodes).toEqual([])
    expect(legacy?.catalog.workflows[0]?.edges).toEqual([])

    const structural = parseXlBuildView({
      catalog: {
        agents: [],
        workflows: [{
          id: 'chain',
          name: 'Chain',
          mermaid: 'graph TD',
          nodes: [{ id: 'start', kind: 'input' }, { id: 'plan', kind: 'agent' }],
          edges: [{ id: 'start-to-plan', from: 'start', to: 'plan', kind: 'flow' }],
        }],
      },
      runs: [validRun],
    })
    expect(structural?.catalog.workflows[0]?.nodes.map((node) => node.id)).toEqual(['start', 'plan'])
    expect(structural?.catalog.workflows[0]?.edges).toHaveLength(1)
  })

  it('returns undefined for a non-object or an object with neither key', () => {
    expect(parseXlBuildView(undefined)).toBeUndefined()
    expect(parseXlBuildView(null)).toBeUndefined()
    expect(parseXlBuildView('text')).toBeUndefined()
    expect(parseXlBuildView({ other: true })).toBeUndefined()
  })
})
