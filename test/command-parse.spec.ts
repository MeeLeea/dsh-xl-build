import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createWorkflowCommand, parseCommand, runWorkflowCommand, workflowInputHint } from '../src/host/commands/workflow.ts'
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

const TWO_PARAM_YAML = [
  'schemaVersion: 1',
  'id: two',
  'name: Two inputs',
  'entry: start',
  'nodes:',
  '  - kind: input',
  '    id: start',
  '    params:',
  '      - name: version',
  '        required: true',
  '      - name: channel',
  '        required: true',
  '  - kind: output',
  '    id: done',
  '    value: "{{input.version}} {{input.channel}}"',
  'edges:',
  '  - id: e1',
  '    from: start',
  '    to: done',
  '    kind: flow',
].join('\n')

const MIXED_YAML = [
  'schemaVersion: 1',
  'id: mixed',
  'name: Mixed inputs',
  'entry: start',
  'nodes:',
  '  - kind: input',
  '    id: start',
  '    params:',
  '      - name: goal',
  '        required: true',
  '      - name: label',
  '        default: ""',
  '  - kind: output',
  '    id: done',
  '    value: "{{input.goal}} {{input.label}}"',
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

  it('parses a positional input and keeps flag order free', () => {
    expect(parseCommand('run release "2.0"')).toEqual({ kind: 'run', id: 'release', inputs: {}, positionalInput: '2.0' })
    expect(parseCommand('run release --self finish "2.0"')).toEqual({
      kind: 'run',
      id: 'release',
      inputs: {},
      selfNodeId: 'finish',
      positionalInput: '2.0',
    })
    expect(parseCommand("run release '2.0' --input k=v")).toEqual({
      kind: 'run',
      id: 'release',
      inputs: { k: 'v' },
      positionalInput: '2.0',
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
    ['two positional inputs', 'run r a b'],
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

  it('returns an error result when the runtime rejects instead of throwing', async () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'release.yml'), GOOD_YAML)
    const runtime: WorkflowRunRuntime = {
      startRun: async () => { throw new Error('engine wiring failed') },
    }
    const initiator = { id: 'initiator-1', followup: () => {} } as Agent
    const result = await runWorkflowCommand('run release --input version=2', { workflowsDir: dir, runtime }, initiator)
    expect(result).toMatchObject({ kind: 'error', text: expect.stringContaining('engine wiring failed') })
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

  it('fills the single declared input from a positional goal', async () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'release.yml'), GOOD_YAML)
    const calls: { inputs: Record<string, string> }[] = []
    const runtime: WorkflowRunRuntime = {
      startRun: async ({ inputs }) => {
        calls.push({ inputs })
        return { runId: 'run-1' }
      },
    }
    const initiator = { id: 'initiator-1', followup: () => {} } as Agent
    const result = await runWorkflowCommand('run release "2.0"', { workflowsDir: dir, runtime }, initiator)
    expect(result).toEqual({ kind: 'success', text: 'started run run-1 for release' })
    expect(calls[0]?.inputs).toEqual({ version: '2.0' })
  })

  it('fills the first required input and names the still-missing ones before starting', async () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'release.yml'), GOOD_YAML)
    writeFileSync(join(dir, 'two.yml'), TWO_PARAM_YAML)
    const inputs: Record<string, string>[] = []
    const runtime: WorkflowRunRuntime = {
      startRun: async ({ inputs: captured }) => { inputs.push(captured); return { runId: 'unused' } },
    }
    const initiator = { id: 'initiator-1', followup: () => {} } as Agent

    const exhausted = await runWorkflowCommand('run release "2.0" --input version=3', { workflowsDir: dir, runtime }, initiator)
    expect(exhausted).toMatchObject({ kind: 'error', text: expect.stringContaining('declares no unfilled run input') })
    expect(inputs).toHaveLength(0)

    const positional = await runWorkflowCommand('run two "x" --input channel=beta', { workflowsDir: dir, runtime }, initiator)
    expect(positional).toEqual({ kind: 'success', text: 'started run unused for two' })
    expect(inputs).toEqual([{ version: 'x', channel: 'beta' }])

    const incomplete = await runWorkflowCommand('run two "x"', { workflowsDir: dir, runtime }, initiator)
    expect(incomplete).toMatchObject({ kind: 'error', text: expect.stringContaining('missing required run inputs: channel') })
    expect(incomplete.text).toContain('--input channel=<value>')
    expect(inputs).toEqual([{ version: 'x', channel: 'beta' }]) // the incomplete run never reaches the runtime
  })

  it('prefers required inputs for the positional goal and falls back to the first declared optional', async () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'mixed.yml'), MIXED_YAML)
    const inputs: Record<string, string>[] = []
    const runtime: WorkflowRunRuntime = {
      startRun: async ({ inputs: captured }) => { inputs.push(captured); return { runId: 'run-2' } },
    }
    const initiator = { id: 'initiator-1', followup: () => {} } as Agent

    const toGoal = await runWorkflowCommand('run mixed "ship it"', { workflowsDir: dir, runtime }, initiator)
    expect(toGoal).toEqual({ kind: 'success', text: 'started run run-2 for mixed' })
    expect(inputs[0]).toEqual({ goal: 'ship it' })

    const toLabel = await runWorkflowCommand('run mixed "nightly" --input goal=x', { workflowsDir: dir, runtime }, initiator)
    expect(toLabel).toEqual({ kind: 'success', text: 'started run run-2 for mixed' })
    expect(inputs[1]).toEqual({ goal: 'x', label: 'nightly' })
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
describe('workflowInputHint', () => {
  it('appends the deduplicated saved ids to the grammar', () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'release.yml'), GOOD_YAML)
    writeFileSync(join(dir, 'release.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'release',
      name: 'Release twin',
      entry: 'start',
      nodes: [{ kind: 'note', id: 'start', text: 'x' }],
      edges: [],
    }))
    writeFileSync(join(dir, 'two.yml'), TWO_PARAM_YAML)

    const hint = workflowInputHint({ workflowsDir: dir })
    expect(hint).toBe('run <id> ["<target>"] [--input k=v] [--self <nodeId>] | list | validate <file> | export <id> --mermaid | ids: release, two')
  })

  it('keeps the bare grammar when nothing valid is saved', () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'broken.yaml'), 'schemaVersion: 1\nid: broken\n')

    expect(workflowInputHint({ workflowsDir: dir }))
      .toBe('run <id> ["<target>"] [--input k=v] [--self <nodeId>] | list | validate <file> | export <id> --mermaid')
  })

  it('deduplicates shipped ids and keeps a shadowed id once', () => {
    const shippedYaml = GOOD_YAML.replace('id: release', 'id: shipped')
    const userDir = workflowsDir()
    writeFileSync(join(userDir, 'shipped.yml'), shippedYaml)
    const builtInDir = workflowsDir()
    writeFileSync(join(builtInDir, 'dup.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'shipped',
      name: 'JSON twin',
      entry: 'start',
      nodes: [{ kind: 'note', id: 'start', text: 'x' }],
      edges: [],
    }))
    writeFileSync(join(builtInDir, 'zdup.yml'), shippedYaml)

    const shadowed = workflowInputHint({ workflowsDir: userDir, builtInWorkflowsDir: builtInDir })
    expect(shadowed).toContain('| ids: shipped')
    expect(shadowed.match(/shipped/g)).toHaveLength(1)

    const shipped = workflowInputHint({ workflowsDir: workflowsDir(), builtInWorkflowsDir: builtInDir })
    expect(shipped).toContain('| ids: shipped')
    expect(shipped.match(/shipped/g)).toHaveLength(1)
  })

  it('advertises the ids in the registered command hint', () => {
    const dir = workflowsDir()
    writeFileSync(join(dir, 'release.yml'), GOOD_YAML)

    const command = createWorkflowCommand({ workflowsDir: dir })
    expect(command.input?.hint).toBe(workflowInputHint({ workflowsDir: dir }))
    expect(command.input?.hint).toContain('| ids: release')
  })
})
