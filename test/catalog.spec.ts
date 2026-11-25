import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCatalog, catalogFingerprint, createCatalogPublisher } from '../src/host/catalog.ts'
import { toMermaid } from '../src/host/workflow/mermaid.ts'
import type { AgentRegistryEntry } from '../src/host/agents/registry.ts'
import type { CatalogPayload } from '../src/host/events.ts'

/** Mutable registry stub over a plain entry list. */
function registryOf(entries: AgentRegistryEntry[]) {
  return { listAgents: () => entries }
}

const VALID: AgentRegistryEntry = {
  status: 'valid',
  file: 'reviewer.yml',
  spec: {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews a diff.',
    prompt: 'SECRET PROMPT',
    provider: 'spawn',
    readOnly: true,
    timeoutMs: 600_000,
  },
}

/** A fresh directory for one test's workflow files. */
function workflowsDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-xl-build-catalog-'))
}

/** One valid workflow document written by the source-change test. */
const RELEASE_YAML = [
  'schemaVersion: 1',
  'id: release',
  'name: Release',
  'entry: start',
  'nodes:',
  '  - kind: note',
  '    id: start',
  '    text: x',
  'edges: []',
].join('\n')

describe('buildCatalog', () => {
  it('lists valid agents without their prompts', () => {
    const broken: AgentRegistryEntry = { status: 'invalid', file: 'bad.yml', error: 'bad.yml: broken' }
    const catalog = buildCatalog(registryOf([VALID, broken]), workflowsDir())
    expect(catalog.agents).toEqual([{ id: 'reviewer', name: 'Reviewer', description: 'Reviews a diff.' }])
    expect(JSON.stringify(catalog)).not.toContain('SECRET PROMPT')
  })

  it('includes saved workflows with their optional description', () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'release.yml'), [
      'schemaVersion: 1',
      'id: release',
      'name: Release',
      'description: Ships the release.',
      'entry: start',
      'nodes:',
      '  - kind: note',
      '    id: start',
      '    text: x',
      'edges: []',
    ].join('\n'))
    writeFileSync(join(dir, 'broken.yaml'), 'schemaVersion: 1\nid: broken\n')

    const catalog = buildCatalog(registryOf([]), dir)
    expect(catalog.workflows).toEqual([
      {
        id: 'release',
        name: 'Release',
        description: 'Ships the release.',
        mermaid: toMermaid({
          schemaVersion: 1,
          id: 'release',
          name: 'Release',
          entry: 'start',
          nodes: [{ kind: 'note', id: 'start', text: 'x' }],
          edges: [],
        }),
      },
    ])
    expect(catalog.workflows[0]?.mermaid).toBe('flowchart TD\n  %% note: x\n')
  })

  it('fingerprints content changes only', () => {
    const dir = workflowsDir()
    const first = buildCatalog(registryOf([VALID]), dir)
    const same = buildCatalog(registryOf([VALID]), dir)
    expect(catalogFingerprint(first)).toBe(catalogFingerprint(same))

    const renamed: AgentRegistryEntry = {
      status: 'valid',
      file: 'reviewer.yml',
      spec: { ...VALID.spec, name: 'Senior Reviewer' },
    }
    expect(catalogFingerprint(buildCatalog(registryOf([renamed]), dir)))
      .not.toBe(catalogFingerprint(first))
  })
})

describe('catalog publisher', () => {
  it('publishes once per Session and again only after a change', () => {
    const entries: AgentRegistryEntry[] = [VALID]
    const publisher = createCatalogPublisher({ registry: registryOf(entries), workflowsDir: workflowsDir() })
    const session = {}
    const written: CatalogPayload[] = []
    const append = (catalog: CatalogPayload): void => { written.push(catalog) }

    publisher.ensure(session, append)
    publisher.ensure(session, append)
    expect(written).toHaveLength(1)

    entries.push({
      status: 'valid',
      file: 'writer.yml',
      spec: { ...VALID.spec, id: 'writer', name: 'Writer' },
    })
    publisher.ensure(session, append)
    expect(written).toHaveLength(2)
    expect(written[1]?.agents.map((agent) => agent.id)).toEqual(['reviewer', 'writer'])
  })

  it('rebuilds only when the workflow source changes and skips a content-preserving touch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-xl-build-catalog-source-'))
    try {
      const publisher = createCatalogPublisher({ registry: registryOf([VALID]), workflowsDir: dir })
      const session = {}
      const written: CatalogPayload[] = []
      const append = (catalog: CatalogPayload): void => { written.push(catalog) }

      // Two calls with an unchanged directory publish once.
      publisher.ensure(session, append)
      publisher.ensure(session, append)
      expect(written).toHaveLength(1)

      // A real content change moves both signatures and appends again.
      writeFileSync(join(dir, 'release.yml'), RELEASE_YAML)
      publisher.ensure(session, append)
      expect(written).toHaveLength(2)
      expect(written[1]?.workflows.map((workflow) => workflow.id)).toEqual(['release'])

      // A touch moves mtime without changing the document: the source signature
      // refreshes, but the catalog content is identical and is not re-published.
      const later = new Date(Date.now() + 10_000)
      utimesSync(join(dir, 'release.yml'), later, later)
      publisher.ensure(session, append)
      expect(written).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('tracks Sessions independently', () => {
    const publisher = createCatalogPublisher({ registry: registryOf([VALID]), workflowsDir: workflowsDir() })
    const written: CatalogPayload[] = []
    const append = (catalog: CatalogPayload): void => { written.push(catalog) }

    publisher.ensure({}, append)
    publisher.ensure({}, append)
    expect(written).toHaveLength(2)
  })
})
