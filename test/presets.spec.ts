import { describe, expect, it } from 'vitest'
import type { AgentPreset, PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { createPresetReconciler, toPresetDefinition } from '../src/host/agents/presets.ts'
import type { PresetRegistrar } from '../src/host/agents/presets.ts'
import type { AgentSpec } from '../src/host/agents/spec.ts'

/** One valid spec with the schema defaults applied. */
function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: 'worker',
    name: 'Worker',
    description: 'Implements a scoped change.',
    prompt: 'You implement the assigned subtask.',
    provider: 'spawn',
    readOnly: true,
    timeoutMs: 600_000,
    ...overrides,
  }
}

/** In-memory registrar recording calls; `failIds` rejects registrations, `brokenIds` marks broken mounts. */
function createRegistrar(): PresetRegistrar & {
  definitions: Map<string, PresetDefinition>
  unregistered: string[]
  registerCalls: number
  failIds: Set<string>
  brokenIds: Set<string>
} {
  const definitions = new Map<string, PresetDefinition>()
  const unregistered: string[] = []
  const failIds = new Set<string>()
  const brokenIds = new Set<string>()
  let registerCalls = 0
  return {
    definitions,
    unregistered,
    get registerCalls() {
      return registerCalls
    },
    failIds,
    brokenIds,
    async register(definition) {
      registerCalls += 1
      if (failIds.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
      definitions.set(definition.id, definition)
      return async () => {
        definitions.delete(definition.id)
        unregistered.push(definition.id)
      }
    },
    list() {
      const presets = [...definitions.keys()].map((id): AgentPreset => ({
        id,
        ...(brokenIds.has(id) ? { broken: 'composition failed to load' } : {}),
      }))
      return Promise.resolve(presets)
    },
  }
}

describe('toPresetDefinition', () => {
  it('maps a read-only spec onto a persona-plus-read-tools preset', () => {
    const { definition, droppedFields } = toPresetDefinition(makeSpec(), 'xl-', 10)

    expect(definition.id).toBe('xl-worker')
    expect(definition.name).toBe('Worker')
    expect(definition.description).toBe('Implements a scoped change. (delegation role; not a session preset)')
    expect(definition.order).toBe(10)
    const [persona, ...tools] = definition.plugins
    expect(persona).toMatchObject({
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: 'You implement the assigned subtask.', complete: true },
    })
    expect(tools.map((row) => row.id)).toEqual(['fs-search', 'fs'])
    expect(tools[1].config).toEqual({ read: true, readImage: true, write: false, edit: false })
    expect(droppedFields).toEqual([])
  })

  it('grants shell and full file tools to a writable spec', () => {
    const { definition, droppedFields } = toPresetDefinition(makeSpec({ readOnly: false }), 'xl-', 11)

    const tools = definition.plugins.slice(1)
    expect(tools.map((row) => row.id)).toEqual(['fs-search', 'fs', 'shell-bash', 'shell-pwsh'])
    expect(tools[1].config).toBeUndefined()
    expect(tools[2].disabled).toBe(process.platform === 'win32')
    expect(tools[3].disabled).toBe(process.platform !== 'win32')
    expect(droppedFields).toEqual([])
  })

  it('lists the spec fields its preset composition drops', () => {
    const { droppedFields } = toPresetDefinition(makeSpec({
      agentPreset: 'standard',
      model: 'deepseek-chat',
      reasoningEffort: 'high',
      maxTokens: 4096,
      cwd: 'D:/work/repo',
      outputSchema: { type: 'object' },
      provider: 'fork',
    }), 'xl-', 10)

    expect(droppedFields).toEqual(['agentPreset', 'model', 'reasoningEffort', 'maxTokens', 'cwd', 'outputSchema', 'provider'])
  })
})

describe('preset reconciler', () => {
  it('registers, updates, and removes presets to mirror the specs', async () => {
    const registrar = createRegistrar()
    const errors: string[] = []
    const reconciler = createPresetReconciler({ registrar, prefix: 'xl-', logError: (m) => errors.push(m), logWarn: () => {} })

    reconciler.reconcile([makeSpec({ id: 'reviewer' })])
    await reconciler.flush()
    expect([...registrar.definitions.keys()]).toEqual(['xl-reviewer'])
    expect(registrar.unregistered).toEqual([])

    reconciler.reconcile([makeSpec({ id: 'reviewer', prompt: 'You review diffs, v2.' })])
    await reconciler.flush()
    expect(registrar.unregistered).toEqual(['xl-reviewer'])
    expect(registrar.definitions.get('xl-reviewer')?.plugins[0]).toMatchObject({ config: { prefix: 'You review diffs, v2.' } })

    reconciler.reconcile([])
    await reconciler.flush()
    expect(registrar.definitions.size).toBe(0)
    expect(registrar.unregistered).toEqual(['xl-reviewer', 'xl-reviewer'])
    expect(errors).toEqual([])
  })

  it('keeps an unchanged snapshot from re-registering', async () => {
    const registrar = createRegistrar()
    const reconciler = createPresetReconciler({ registrar, prefix: 'xl-', logError: () => {}, logWarn: () => {} })

    const specs = [makeSpec({ id: 'a' }), makeSpec({ id: 'b' })]
    reconciler.reconcile(specs)
    await reconciler.flush()
    expect(registrar.registerCalls).toBe(2)

    reconciler.reconcile([...specs])
    await reconciler.flush()
    expect(registrar.registerCalls).toBe(2)
    expect(registrar.unregistered).toEqual([])
  })

  it('isolates a failed registration and keeps the other specs', async () => {
    const registrar = createRegistrar()
    registrar.failIds.add('xl-bad')
    const errors: string[] = []
    const reconciler = createPresetReconciler({ registrar, prefix: 'xl-', logError: (m) => errors.push(m), logWarn: () => {} })

    reconciler.reconcile([makeSpec({ id: 'bad' }), makeSpec({ id: 'good' })])
    await reconciler.flush()

    expect([...registrar.definitions.keys()]).toEqual(['xl-good'])
    expect(errors.join('\n')).toContain('xl-bad')
  })

  it('reports a broken mount through the error sink', async () => {
    const registrar = createRegistrar()
    registrar.brokenIds.add('xl-a')
    const errors: string[] = []
    const reconciler = createPresetReconciler({ registrar, prefix: 'xl-', logError: (m) => errors.push(m), logWarn: () => {} })

    reconciler.reconcile([makeSpec({ id: 'a' })])
    await reconciler.flush()

    expect(errors.join('\n')).toContain('xl-a')
    expect(errors.join('\n')).toContain('broken')
  })

  it('warns once per changed spec about dropped fields', async () => {
    const registrar = createRegistrar()
    const warnings: string[] = []
    const reconciler = createPresetReconciler({ registrar, prefix: 'xl-', logError: () => {}, logWarn: (m) => warnings.push(m) })

    const withModel = makeSpec({ id: 'a', model: 'deepseek-chat' })
    reconciler.reconcile([withModel])
    await reconciler.flush()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('model')

    reconciler.reconcile([withModel])
    await reconciler.flush()
    expect(warnings).toHaveLength(1)
  })

  it('dismounts and remounts the delegation tool with the registered ids', async () => {
    const registrar = createRegistrar()
    const mounts: string[][] = []
    let disposals = 0
    const reconciler = createPresetReconciler({
      registrar,
      prefix: 'xl-',
      logError: () => {},
      logWarn: () => {},
      mountDelegationTool: async (ids) => {
        mounts.push([...ids])
        return async () => {
          disposals += 1
        }
      },
    })

    reconciler.reconcile([makeSpec({ id: 'b' }), makeSpec({ id: 'a' })])
    await reconciler.flush()
    expect(mounts).toEqual([['xl-a', 'xl-b']])

    reconciler.reconcile([makeSpec({ id: 'a' })])
    await reconciler.flush()
    expect(mounts).toEqual([['xl-a', 'xl-b'], ['xl-a']])
    expect(disposals).toBe(1)

    await reconciler.dispose()
    expect(disposals).toBe(2)
    expect(registrar.definitions.size).toBe(0)
    expect(registrar.unregistered).toEqual(['xl-b', 'xl-a'])
  })

  it('retries the delegation-tool mount after a failed mount', async () => {
    const registrar = createRegistrar()
    const errors: string[] = []
    const mounts: string[][] = []
    let attempts = 0
    const reconciler = createPresetReconciler({
      registrar,
      prefix: 'xl-',
      logError: (m) => errors.push(m),
      logWarn: () => {},
      mountDelegationTool: async (ids) => {
        attempts += 1
        if (attempts === 1) throw new Error('mount failed')
        mounts.push([...ids])
        return async () => {}
      },
    })

    // First mount rejects: no tool is mounted, but the failure is reported and
    // the reconciler state still describes "not mounted".
    reconciler.reconcile([makeSpec({ id: 'a' })])
    await reconciler.flush()
    expect(attempts).toBe(1)
    expect(mounts).toEqual([])
    expect(errors.join('\n')).toContain('mounting the delegation tool failed')

    // The next reconcile with the same specs retries and mounts the new ids.
    reconciler.reconcile([makeSpec({ id: 'a' })])
    await reconciler.flush()
    expect(attempts).toBe(2)
    expect(mounts).toEqual([['xl-a']])
  })

  it('ignores reconcile after dispose and drains pending work', async () => {
    const registrar = createRegistrar()
    const reconciler = createPresetReconciler({ registrar, prefix: 'xl-', logError: () => {}, logWarn: () => {} })

    reconciler.reconcile([makeSpec({ id: 'a' })])
    await reconciler.dispose()
    expect(registrar.definitions.size).toBe(0)

    reconciler.reconcile([makeSpec({ id: 'late' })])
    await reconciler.flush()
    expect(registrar.definitions.size).toBe(0)
  })
})
