/**
 * Registration of agent specs as dsh agent presets.
 *
 * One valid spec becomes one preset (id `prefix + spec.id`) whose composition
 * carries the spec prompt as the child's complete persona and trims tools from
 * `readOnly`. The preset ids are what a delegation tool lists under
 * `agent_preset`, so they are the model-selectable face of the agents
 * directory; `xl_agent_run` keeps serving the full spec semantics that a
 * preset composition cannot express.
 */
import type { AgentPreset, PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { AgentSpec } from './spec.ts'

/** One plugin row inside a preset composition. */
type PresetRow = PresetDefinition['plugins'][number]

/** Spec fields the preset composition cannot carry; their guarantees stay on the `xl_agent_run` path. */
const PRESET_UNEXPRESSIBLE_FIELDS = [
  'agentPreset',
  'model',
  'reasoningEffort',
  'maxTokens',
  'cwd',
  'outputSchema',
] as const

/** Preset display order base: above the shipped presets (1-4) so role presets sort last in pickers. */
const PRESET_ORDER_BASE = 900

/** Suffix steering users away from selecting a delegation role as a session preset. */
const ROLE_PRESET_DESCRIPTION_SUFFIX = ' (delegation role; not a session preset)'

/** The preset-registry face the reconciler consumes; structural so tests can fake it. */
export interface PresetRegistrar {
  /** Register one preset; rejects on a duplicate or empty id. */
  register(definition: PresetDefinition): Promise<() => Promise<void>>
  /** Current presets with their `broken` diagnostics. */
  list(): Promise<readonly AgentPreset[]>
}

/** Result of mapping one agent spec onto a preset. */
export interface SpecPresetMapping {
  /** The preset definition to register. */
  definition: PresetDefinition
  /** Spec fields that are set but dropped by the preset composition. */
  droppedFields: readonly string[]
}

/**
 * Map one agent spec onto a preset definition.
 * @param spec - validated agent definition.
 * @param prefix - namespace prepended to the spec id to form the process-globally unique preset id.
 * @param order - display order among sibling presets.
 * @returns the definition plus the fields its composition drops.
 */
export function toPresetDefinition(spec: AgentSpec, prefix: string, order: number): SpecPresetMapping {
  const droppedFields: string[] = PRESET_UNEXPRESSIBLE_FIELDS.filter((field) => spec[field] !== undefined)
  if (spec.provider !== 'spawn') droppedFields.push('provider')
  const definition: PresetDefinition = {
    id: `${prefix}${spec.id}`,
    name: spec.name,
    description: spec.description + ROLE_PRESET_DESCRIPTION_SUFFIX,
    order,
    plugins: [
      // `complete` makes the spec prompt the child's entire system prompt,
      // matching the shipped minimal preset's persona policy.
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: spec.prompt, complete: true } },
      ...spec.readOnly
        ? readOnlyToolRows()
        : writableToolRows(),
    ],
  }
  return { definition, droppedFields }
}

/** Tool rows for a writable child: file search, full file tools, and the platform shell. */
function writableToolRows(): PresetRow[] {
  return [
    { id: 'fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
    { id: 'fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'shell-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: process.platform === 'win32' },
    { id: 'shell-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: process.platform !== 'win32' },
  ]
}

/** Tool rows for a read-only child: reads and search only. No shell, no mutations. */
function readOnlyToolRows(): PresetRow[] {
  return [
    { id: 'fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
    {
      id: 'fs',
      name: '@deepseek-ai/dsh-tool-fs',
      config: { read: true, readImage: true, write: false, edit: false },
    },
  ]
}

/** One preset this reconciler currently owns. */
interface RegisteredPreset {
  /** Stable content signature; any change re-registers the preset. */
  readonly signature: string
  /** Registry disposer from `register()`. */
  readonly unregister: () => Promise<void>
}

/** Keeps the registered presets in step with the live agent snapshot. */
export interface PresetReconciler {
  /** Register, update, and remove presets so they mirror the given specs. */
  reconcile(specs: readonly AgentSpec[]): void
  /** Resolve when every enqueued reconciliation step has settled. */
  flush(): Promise<void>
  /** Unregister every owned preset, dispose the delegation tool, and drain pending work. */
  dispose(): Promise<void>
}

/**
 * Create the reconciler. Steps run on a serial queue so a reload never
 * interleaves a registration with a pending removal of the same id, and the
 * delegation tool only ever mounts after the ids it lists are registered.
 * @param options - registrar, id prefix, log sinks, and the delegation-tool mount hook.
 * @returns the reconciler to feed on every agent-snapshot reload.
 */
export function createPresetReconciler(options: {
  registrar: PresetRegistrar
  /** Namespace prepended to each spec id. */
  prefix: string
  logError: (message: string) => void
  logWarn: (message: string) => void
  /**
   * Mount (or remount) the delegation tool listing exactly these sorted preset
   * ids; resolve the returned disposer once the previous mount is gone.
   * Omission skips mounting (registration only).
   */
  mountDelegationTool?: (presetIds: readonly string[]) => Promise<() => Promise<void>> | (() => Promise<void>) | (() => void)
}): PresetReconciler {
  const { registrar, prefix } = options
  const registered = new Map<string, RegisteredPreset>()
  let tail: Promise<void> = Promise.resolve()
  let disposed = false
  let toolDisposer: (() => void | Promise<void>) | undefined
  let toolIds: readonly string[] = []

  const enqueue = (step: () => Promise<void>): void => {
    tail = tail.then(step).catch((error: unknown) => {
      options.logError(`preset reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

  /**
   * Remount the delegation tool when the registered-id set changed.
   *
   * `toolIds`/`toolDisposer` describe what is actually mounted: they are
   * committed only after a mount resolves, and a failure leaves them naming
   * the previous mount (or "not mounted"), so the next reconcile retries.
   */
  const syncTool = async (): Promise<void> => {
    const ids = [...registered.keys()].map((specId) => `${prefix}${specId}`).sort()
    if (ids.length === toolIds.length && ids.every((id, index) => id === toolIds[index])) return
    const previous = toolDisposer
    // No replacement is mounted: tear down the owned tool and record "not mounted".
    if (ids.length === 0 || options.mountDelegationTool === undefined) {
      toolDisposer = undefined
      toolIds = ids
      if (previous !== undefined) {
        try {
          await previous()
        } catch (error) {
          options.logError(`disposing the delegation tool failed: ${describe(error)}`)
        }
      }
      return
    }
    // A replacement will be mounted: drop the previous tool first, then mount.
    toolDisposer = undefined
    toolIds = []
    if (previous !== undefined) {
      try {
        await previous()
      } catch (error) {
        options.logError(`disposing the delegation tool failed: ${describe(error)}`)
      }
    }
    try {
      toolDisposer = await options.mountDelegationTool(ids)
      toolIds = ids
    } catch (error) {
      options.logError(`mounting the delegation tool failed: ${describe(error)}`)
    }
  }

  return {
    reconcile(specs) {
      if (disposed) return
      enqueue(async () => {
        const desired = new Map(specs.map((spec) => [spec.id, spec]))
        for (const [specId, entry] of [...registered]) {
          if (desired.has(specId)) continue
          registered.delete(specId)
          try {
            await entry.unregister()
          } catch (error) {
            options.logError(`unregistering preset ${prefix}${specId} failed: ${describe(error)}`)
          }
        }
        const ordered = [...desired]
        for (const [index, [specId, spec]] of ordered.entries()) {
          const { definition, droppedFields } = toPresetDefinition(spec, prefix, PRESET_ORDER_BASE + index)
          // `order` mirrors the listing position, so it is excluded from the
          // content signature: a reorder must not tear down mounted presets.
          const signature = JSON.stringify({ ...definition, order: 0 })
          const existing = registered.get(specId)
          if (existing !== undefined && existing.signature === signature) continue
          if (existing !== undefined) {
            registered.delete(specId)
            try {
              await existing.unregister()
            } catch (error) {
              options.logError(`unregistering preset ${definition.id} failed: ${describe(error)}`)
            }
          }
          if (droppedFields.length > 0) {
            options.logWarn(`${definition.id}: the preset path drops ${droppedFields.join(', ')}`
              + '; those guarantees remain on the xl_agent_run path')
          }
          try {
            const unregister = await registrar.register(definition)
            registered.set(specId, { signature, unregister })
          } catch (error) {
            options.logError(`registering preset ${definition.id} failed: ${describe(error)}`)
            continue
          }
          const broken = (await registrar.list()).find((preset) => preset.id === definition.id)?.broken
          if (broken !== undefined) options.logError(`preset ${definition.id} mounted broken: ${broken}`)
        }
        await syncTool()
      })
    },
    flush() {
      return tail
    },
    dispose() {
      disposed = true
      const finish = tail.then(async () => {
        const previous = toolDisposer
        toolDisposer = undefined
        toolIds = []
        if (previous !== undefined) await previous()
        for (const [specId, entry] of [...registered]) {
          registered.delete(specId)
          await entry.unregister()
        }
      })
      tail = finish
      return finish
    },
  }
}
