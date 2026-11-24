import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentRegistry } from '../src/host/agents/registry.ts'
import type { EffectScope } from '../src/host/agents/registry.ts'

/** Minimal effect scope: records disposers and runs them on `dispose`. */
function createScope(): { scope: EffectScope, dispose: () => void } {
  const disposers: (() => void)[] = []
  return {
    scope: {
      effect: (callback: () => () => void) => {
        const disposer = callback()
        disposers.push(disposer)
        return disposer
      },
    },
    dispose: () => {
      for (const disposer of disposers.splice(0)) disposer()
    },
  }
}

/** Poll until `predicate` holds so reload timing does not need fixed sleeps. */
async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('waitFor timed out')
}

/** Create a fresh directory for one test's agent definitions. */
function createAgentsDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'dsh-xl-build-agents-')), 'agents')
  mkdirSync(dir, { recursive: true })
  return dir
}

const REVIEWER = {
  id: 'reviewer',
  name: 'Reviewer',
  description: 'Reviews a diff.',
  prompt: 'You review diffs.',
}

describe('agent registry', () => {
  it('loads yml, yaml, and json definitions and resolves by id', () => {
    const dir = createAgentsDir()
    writeFileSync(join(dir, 'reviewer.yml'), `id: reviewer\nname: Reviewer\ndescription: Reviews a diff.\nprompt: You review diffs.\n`)
    writeFileSync(join(dir, 'writer.yaml'), `id: writer\nname: Writer\ndescription: Writes docs.\nprompt: You write docs.\n`)
    writeFileSync(join(dir, 'tester.json'), JSON.stringify({ id: 'tester', name: 'Tester', description: 'Tests.', prompt: 'You test.' }))

    const { scope } = createScope()
    const registry = createAgentRegistry(scope, { agentsDir: dir })

    expect(registry.listAgents()).toHaveLength(3)
    expect(registry.resolveAgent('reviewer')?.readOnly).toBe(true)
    expect(registry.resolveAgent('writer')?.name).toBe('Writer')
    expect(registry.resolveAgent('tester')?.prompt).toBe('You test.')
    expect(registry.resolveAgent('missing')).toBeUndefined()
  })

  it('keeps a broken file isolated and reports its error', () => {
    const dir = createAgentsDir()
    writeFileSync(join(dir, 'good.yml'), `id: good\nname: Good\ndescription: Works.\nprompt: Work.\n`)
    writeFileSync(join(dir, 'bad.yaml'), `id: Bad_Name\nname: Bad\ndescription: Broken.\nprompt: Nope.\n`)

    const { scope } = createScope()
    const registry = createAgentRegistry(scope, { agentsDir: dir })

    expect(registry.resolveAgent('good')?.name).toBe('Good')
    const invalid = registry.listAgents().find((entry) => entry.status === 'invalid')
    expect(invalid).toBeDefined()
    expect(invalid?.file).toBe('bad.yaml')
    expect(invalid?.error).toContain('bad.yaml')
    expect(invalid?.error).toContain('id')
  })

  it('marks a duplicate id as invalid on the later file', async () => {
    const dir = createAgentsDir()
    writeFileSync(join(dir, 'a.yml'), `id: reviewer\nname: A\ndescription: First.\nprompt: First.\n`)
    writeFileSync(join(dir, 'b.yml'), `id: reviewer\nname: B\ndescription: Second.\nprompt: Second.\n`)

    const { scope } = createScope()
    const registry = createAgentRegistry(scope, { agentsDir: dir })

    expect(registry.resolveAgent('reviewer')?.name).toBe('A')
    const invalid = registry.listAgents().find((entry) => entry.status === 'invalid')
    expect(invalid?.file).toBe('b.yml')
    expect(invalid?.error).toContain('duplicate agent id')
  })

  it('reloads when a definition file is added or edited', async () => {
    const dir = createAgentsDir()
    const { scope } = createScope()
    const registry = createAgentRegistry(scope, { agentsDir: dir })
    expect(registry.listAgents()).toHaveLength(0)

    writeFileSync(join(dir, 'reviewer.yml'), `id: reviewer\nname: Reviewer\ndescription: Reviews a diff.\nprompt: You review diffs.\n`)
    await waitFor(() => registry.resolveAgent('reviewer') !== undefined)

    writeFileSync(join(dir, 'reviewer.yml'), `id: reviewer\nname: Reviewer v2\ndescription: Reviews a diff.\nprompt: You review diffs.\n`)
    await waitFor(() => registry.resolveAgent('reviewer')?.name === 'Reviewer v2')
  })

  it('stops reloading after the effect scope is disposed', async () => {
    const dir = createAgentsDir()
    const { scope, dispose } = createScope()
    const registry = createAgentRegistry(scope, { agentsDir: dir })
    dispose()

    writeFileSync(join(dir, 'late.yml'), `id: late\nname: Late\ndescription: Late.\nprompt: Late.\n`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(registry.resolveAgent('late')).toBeUndefined()
  })
})
