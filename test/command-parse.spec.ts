import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { parseCommand, runWorkflowCommand } from '../src/host/commands/workflow.ts'
import type { WorkflowRunRuntime } from '../src/host/workflow/run.ts'
import { parseWorkflowDocument } from '../src/host/workflow/domain.ts'
import { loadWorkflowDirectory, parseWorkflowText } from '../src/host/workflow/loaders.ts'
import { validateWorkflow } from '../src/host/workflow/validate.ts'

/** Parse a document fixture built from raw node and edge literals. */
function docOf(nodes: unknown[], edges: unknown[] = [], entry = 'start') {
  return parseWorkflowDocument({ schemaVersion: 1, id: 'release', name: 'Release', entry, nodes, edges })
}

/** A fresh directory for one test's workflow files. */
function workflowsDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-xl-build-workflows-'))
}

const GOOD_YAML = [
  'schemaVersion: 1',
  'id: release',
  'name: Release',
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

describe('parseCommand', () => {
  it('parses list and validate', () => {
    expect(parseCommand('list')).toEqual({ kind: 'list' })
    expect(parseCommand('  validate  wf.yml ')).toEqual({ kind: 'validate', file: 'wf.yml' })
  })

  it('parses run inputs with the documented k=v rules', () => {
    expect(parseCommand('run release')).toEqual({ kind: 'run', id: 'release', inputs: {} })
    expect(parseCommand('run release --input k=v')).toEqual({ kind: 'run', id: 'release', inputs: { k: 'v' } })
    expect(parseCommand('run release --input k=v=w')).toEqual({ kind: 'run', id: 'release', inputs: { k: 'v=w' } })
    expect(parseCommand('run release --input a="hello world"')).toEqual({
      kind: 'run',
      id: 'release',
      inputs: { a: 'hello world' },
    })
    expect(parseCommand('run release --input x=1 --input x=2')).toEqual({
      kind: 'run',
      id: 'release',
      inputs: { x: '2' },
    })
    expect(parseCommand('run release --input k=v --self finish')).toEqual({
      kind: 'run',
      id: 'release',
      inputs: { k: 'v' },
      selfNodeId: 'finish',
    })
  })

  it('parses export with only the mermaid format', () => {
    expect(parseCommand('export release --mermaid')).toEqual({ kind: 'export', id: 'release', format: 'mermaid' })
  })

  it.each([
    ['missing subcommand', ''],
    ['unknown subcommand', 'bogus'],
    ['run without id', 'run'],
    ['unknown run option', 'run r --bogus x'],
    ['input without k=v', 'run r --input novalue'],
    ['self without node', 'run r --self'],
    ['list with arguments', 'list now'],
    ['validate without file', 'validate'],
    ['validate with two files', 'validate a.yml b.yml'],
    ['self on list', 'list --self n'],
    ['export without format', 'export r'],
    ['export with a foreign format', 'export r --json'],
  ])('answers usage for %s', (_label, input) => {
    const parsed = parseCommand(input)
    expect(parsed.kind).toBe('usage')
    expect(parsed.kind === 'usage' ? parsed.text : '').toContain('usage: /workflow')
  })
})

describe('workflow loaders', () => {
  it('lists valid and invalid files without hiding either', () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'release.yml'), GOOD_YAML)
    writeFileSync(join(dir, 'broken.yaml'), 'schemaVersion: 1\nid: broken\n')

    const entries = loadWorkflowDirectory(dir)
    expect(entries.map((entry) => entry.file)).toEqual(['broken.yaml', 'release.yml'])
    expect(entries[0]?.status).toBe('invalid')
    expect(entries[1]?.status).toBe('valid')
  })

  it('parses json and reports the file on a schema violation', () => {
    expect(parseWorkflowText(JSON.stringify({
      schemaVersion: 1,
      id: 'release',
      name: 'Release',
      entry: 'start',
      nodes: [{ kind: 'note', id: 'start', text: 'x' }],
      edges: [],
    }), 'release.json').id).toBe('release')
    expect(() => parseWorkflowText('{"schemaVersion": 2}', 'bad.json')).toThrow('bad.json')
  })

  it('treats a missing directory as an empty catalog', () => {
    expect(loadWorkflowDirectory(join(workflowsDir(), 'absent'))).toEqual([])
  })
})

describe('validateWorkflow', () => {
  it('accepts a minimal valid document', () => {
    const document = parseWorkflowText(GOOD_YAML, 'release.yml')
    expect(validateWorkflow(document)).toEqual([])
  })

  it('reports duplicate ids as V1', () => {
    const document = docOf([
      { kind: 'note', id: 'aa', text: 'x' },
      { kind: 'note', id: 'aa', text: 'y' },
    ])
    expect(validateWorkflow(document).some((issue) => issue.rule === 'V1')).toBe(true)
  })

  it('reports an unknown entry as V2', () => {
    const document = docOf([{ kind: 'note', id: 'aa', text: 'x' }], [], 'missing')
    expect(validateWorkflow(document).some((issue) => issue.rule === 'V2')).toBe(true)
  })

  it('reports a self-loop and unknown endpoints as V3', () => {
    const document = docOf([{ kind: 'note', id: 'aa', text: 'x' }], [
      { id: 'e1', from: 'aa', to: 'aa', kind: 'flow' },
      { id: 'e2', from: 'aa', to: 'ghost', kind: 'flow' },
    ])
    const issues = validateWorkflow(document)
    expect(issues.filter((issue) => issue.rule === 'V3')).toHaveLength(2)
  })

  it('reports degree violations as V4', () => {
    const withInEdge = docOf([
      { kind: 'agent', id: 'aa', agent: 'reviewer', task: 't' },
      { kind: 'note', id: 'note', text: 'x' },
    ], [{ id: 'e1', from: 'aa', to: 'note', kind: 'flow' }])
    expect(validateWorkflow(withInEdge).map((issue) => issue.message))
      .toContain('note node "note" must not have in-edges')

    const dangling = docOf([
      { kind: 'agent', id: 'aa', agent: 'reviewer', task: 't' },
      { kind: 'note', id: 'note', text: 'x' },
    ])
    expect(validateWorkflow(dangling).map((issue) => issue.message))
      .toContain('agent node "aa" has no out-edge')
  })
})

describe('runWorkflowCommand', () => {
  it('lists saved workflows with node and edge counts', async () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'release.yml'), GOOD_YAML)
    const result = await runWorkflowCommand('list', { workflowsDir: dir })
    expect(result).toEqual({
      kind: 'success',
      text: '- release: Release (2 nodes, 1 edges)',
    })
  })

  it('flags a broken file in the listing', async () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'broken.yaml'), 'schemaVersion: 1\nid: broken\n')
    const result = await runWorkflowCommand('list', { workflowsDir: dir })
    expect(result.kind).toBe('success')
    expect(result.text).toContain('broken.yaml: invalid')
  })

  it('validates a file relative to the working directory', async () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'release.yml'), GOOD_YAML)
    await expect(runWorkflowCommand('validate release.yml', { workflowsDir: dir, cwd: dir }))
      .resolves.toEqual({ kind: 'success', text: 'Valid: release (2 nodes, 1 edges)' })
    await expect(runWorkflowCommand('validate absent.yml', { workflowsDir: dir, cwd: dir }))
      .resolves.toMatchObject({ kind: 'error' })
  })

  it('reports schema violations for validate and usage for bad input', async () => {
    const dir = workflowsDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'bad.yml'), 'schemaVersion: 1\nid: bad\n')
    const failed = await runWorkflowCommand('validate bad.yml', { workflowsDir: dir, cwd: dir })
    expect(failed.kind).toBe('error')
    expect(failed.text).toContain('bad.yml')

    const usage = await runWorkflowCommand('bogus', { workflowsDir: dir })
    expect(usage.kind).toBe('error')
    expect(usage.text).toContain('usage: /workflow')
  })

  it('hands a saved workflow to the runtime and reports the started run', async () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'release.yml'), GOOD_YAML)
    const calls: { inputs: Record<string, string>, selfNodeId: string | undefined, initiator: unknown }[] = []
    const runtime: WorkflowRunRuntime = {
      startRun: async ({ inputs, selfNodeId }, initiator) => {
        calls.push({ inputs, selfNodeId, initiator })
        return { runId: 'run-123' }
      },
    }
    const initiator = { id: 'initiator-1', followup: () => {} } as Agent
    const result = await runWorkflowCommand('run release --input version=2 --self start', { workflowsDir: dir, runtime }, initiator)
    expect(result).toEqual({ kind: 'success', text: 'started run run-123 for release' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.inputs).toEqual({ version: '2' })
    expect(calls[0]?.selfNodeId).toBe('start')
    expect((calls[0]?.initiator as { id: string }).id).toBe('initiator-1')
  })

  it('still refuses run without a runtime and unknown ids with one', async () => {
    const dir = workflowsDir()
    const run = await runWorkflowCommand('run release', { workflowsDir: dir })
    expect(run).toMatchObject({ kind: 'error', text: expect.stringContaining('/workflow run is not available yet') })

    writeFileSync(join(dir, 'release.yml'), GOOD_YAML)
    const runtime: WorkflowRunRuntime = { startRun: async () => ({ runId: 'unused' }) }
    const initiator = { id: 'initiator-1', followup: () => {} } as Agent
    const missing = await runWorkflowCommand('run ghost', { workflowsDir: dir, runtime }, initiator)
    expect(missing).toMatchObject({ kind: 'error', text: expect.stringContaining('workflow "ghost" is not saved') })
  })

  it('exports a saved workflow as mermaid', async () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'release.yml'), GOOD_YAML)
    const exported = await runWorkflowCommand('export release --mermaid', { workflowsDir: dir })
    expect(exported).toMatchObject({ kind: 'success', text: expect.stringContaining('flowchart TD') })
    expect(exported.text).toContain('start')
    expect(exported.text).toContain('done')
  })
})
