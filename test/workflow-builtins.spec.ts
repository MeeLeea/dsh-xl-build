import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { runWorkflowCommand } from '../src/host/commands/workflow.ts'
import type { WorkflowRunRuntime } from '../src/host/workflow/run.ts'
import {
  BUILT_IN_WORKFLOW_MARKER,
  loadMergedWorkflowCatalog,
  readBuiltInWorkflowCatalog,
  resolveBuiltInWorkflowsDir,
} from '../src/host/workflow/builtins.ts'

/** A fresh directory for one test's workflow files. */
function workflowsDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-xl-build-workflows-'))
}

/** Write one workflow document file and return its directory. */
function writeWorkflow(fileName: string, lines: readonly string[]): string {
  const dir = workflowsDir()
  writeFileSync(join(dir, fileName), lines.join('\n'))
  return dir
}

const SHIPPED_YAML = [
  'schemaVersion: 1',
  'id: shipped',
  'name: Shipped',
  'entry: start',
  'nodes:',
  '  - kind: input',
  '    id: start',
  '    params:',
  '      - name: version',
  '        required: true',
  '  - kind: output',
  '    id: done',
  '    value: "{{input.version}}"',
  'edges:',
  '  - id: e1',
  '    from: start',
  '    to: done',
  '    kind: flow',
].join('\n')

const USER_SHADOW_YAML = SHIPPED_YAML
  .replace('id: shipped', 'id: shipped')
  .replace('name: Shipped', 'name: User override')

/** A runtime stub recording every startRun call. */
function recordingRuntime(): { runtime: WorkflowRunRuntime, calls: { id: string, name: string }[] } {
  const calls: { id: string, name: string }[] = []
  return {
    calls,
    runtime: {
      startRun: async ({ document }) => {
        calls.push({ id: document.id, name: document.name })
        return { runId: 'run-1' }
      },
    },
  }
}

const INITIATOR = { id: 'initiator-1', followup: () => {} } as Agent

describe('resolveBuiltInWorkflowsDir', () => {
  it('locates the shipped workflow directory of this package', () => {
    const dir = resolveBuiltInWorkflowsDir()
    expect(dir).toBeDefined()
    expect(basename(dir!)).toBe('workflow')
    expect(join(dir!, BUILT_IN_WORKFLOW_MARKER)).toMatch(/xl-build-pipeline\.yml$/)
  })
})

describe('readBuiltInWorkflowCatalog', () => {
  it('accepts the shipped directory as all valid', () => {
    const dir = resolveBuiltInWorkflowsDir()
    expect(dir).toBeDefined()
    const entries = readBuiltInWorkflowCatalog(dir!)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((entry) => entry.status === 'valid')).toBe(true)
  })

  it('throws when a shipped file fails to parse', () => {
    const dir = writeWorkflow('broken.yml', ['schemaVersion: 1', 'id: broken'])
    expect(() => readBuiltInWorkflowCatalog(dir)).toThrow('broken built-in workflow definitions')
  })
})

describe('loadMergedWorkflowCatalog', () => {
  it('merges shipped documents under the user catalog', () => {
    const userDir = writeWorkflow('release.yml', [
      'schemaVersion: 1',
      'id: release',
      'name: Release',
      'entry: start',
      'nodes:',
      '  - kind: output',
      '    id: start',
      '    value: "x"',
      'edges: []',
    ])
    const builtInDir = writeWorkflow('shipped.yml', SHIPPED_YAML.split('\n'))

    const { entries, builtInIds } = loadMergedWorkflowCatalog(userDir, builtInDir)
    expect(entries.map((entry) => entry.status === 'valid' ? entry.document.id : entry.file))
      .toEqual(['release', 'shipped'])
    expect([...builtInIds]).toEqual(['shipped'])
  })

  it('shadows a shipped id with a valid user document', () => {
    const userDir = writeWorkflow('override.yml', USER_SHADOW_YAML.split('\n'))
    const builtInDir = writeWorkflow('shipped.yml', SHIPPED_YAML.split('\n'))

    const { entries, builtInIds } = loadMergedWorkflowCatalog(userDir, builtInDir)
    const ids = entries.flatMap((entry) => entry.status === 'valid' ? [entry.document.id] : [])
    expect(ids).toEqual(['shipped'])
    expect(entries[0]?.status === 'valid' && entries[0].document.name).toBe('User override')
    expect(builtInIds.size).toBe(0)
  })

  it('collapses shipped duplicate ids to the first file in name order', () => {
    const userDir = workflowsDir()
    mkdirSync(userDir, { recursive: true })
    const builtInDir = writeWorkflow('dup.json', [JSON.stringify({
      schemaVersion: 1,
      id: 'shipped',
      name: 'JSON twin',
      entry: 'start',
      nodes: [{ kind: 'note', id: 'start', text: 'x' }],
      edges: [],
    })])
    writeFileSync(join(builtInDir, 'zdup.yml'), SHIPPED_YAML)

    const { entries } = loadMergedWorkflowCatalog(userDir, builtInDir)
    const shipped = entries.filter((entry) => entry.status === 'valid' && entry.document.id === 'shipped')
    expect(shipped).toHaveLength(1)
    expect(shipped[0]?.status === 'valid' && shipped[0].document.name).toBe('JSON twin')
  })
})

describe('workflow command with a built-in catalog', () => {
  it('runs a shipped workflow without a user document', async () => {
    const { runtime, calls } = recordingRuntime()
    const result = await runWorkflowCommand('run shipped "2.0"', {
      workflowsDir: workflowsDir(),
      builtInWorkflowsDir: writeWorkflow('shipped.yml', SHIPPED_YAML.split('\n')),
      runtime,
    }, INITIATOR)
    expect(result).toEqual({ kind: 'success', text: 'started run run-1 for shipped' })
    expect(calls).toEqual([{ id: 'shipped', name: 'Shipped' }])
  })

  it('prefers a user document over the shipped one with the same id', async () => {
    const { runtime, calls } = recordingRuntime()
    const result = await runWorkflowCommand('run shipped --input version=2', {
      workflowsDir: writeWorkflow('override.yml', USER_SHADOW_YAML.split('\n')),
      builtInWorkflowsDir: writeWorkflow('shipped.yml', SHIPPED_YAML.split('\n')),
      runtime,
    }, INITIATOR)
    expect(result.kind).toBe('success')
    expect(calls[0]?.name).toBe('User override')
  })

  it('marks shipped entries in the listing and hides shadowed ones', async () => {
    const builtInDir = writeWorkflow('shipped.yml', SHIPPED_YAML.split('\n'))

    const plain = await runWorkflowCommand('list', { workflowsDir: workflowsDir(), builtInWorkflowsDir: builtInDir })
    expect(plain.text).toContain('- shipped: Shipped (2 nodes, 1 edges) (builtin)')

    const shadowed = await runWorkflowCommand('list', {
      workflowsDir: writeWorkflow('override.yml', USER_SHADOW_YAML.split('\n')),
      builtInWorkflowsDir: builtInDir,
    })
    expect(shadowed.text).toContain('- shipped: User override (2 nodes, 1 edges)')
    expect(shadowed.text).not.toContain('(builtin)')
  })

  it('exports a shipped workflow and names the shipped catalog on a miss', async () => {
    const builtInDir = writeWorkflow('shipped.yml', SHIPPED_YAML.split('\n'))

    const exported = await runWorkflowCommand('export shipped --mermaid', {
      workflowsDir: workflowsDir(),
      builtInWorkflowsDir: builtInDir,
    })
    expect(exported.kind).toBe('success')
    expect(exported.text).toContain('flowchart TD')

    const missing = await runWorkflowCommand('run ghost', {
      workflowsDir: workflowsDir(),
      builtInWorkflowsDir: builtInDir,
      runtime: { startRun: async () => ({ runId: 'unused' }) },
    }, INITIATOR)
    expect(missing).toMatchObject({ kind: 'error', text: expect.stringContaining('or shipped with the plugin') })
  })
})
