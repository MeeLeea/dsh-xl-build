/**
 * Agent definition directory: synchronous scan, hot reload, and the single
 * resolution entry point shared by tools, commands, and `@` mentions.
 *
 * A broken file only marks its own entry `invalid` and keeps a readable error;
 * it never blocks the other definitions. Reload replaces the registry snapshot,
 * so a run that already started keeps the `AgentSpec` object it captured.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, watch } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from 'js-yaml'
import type { Config } from '../config.ts'
import { AgentSpecSchema } from './spec.ts'
import type { AgentSpec } from './spec.ts'

/** Extensions the agent directory loader accepts. */
export const AGENT_FILE_EXTENSIONS: ReadonlySet<string> = new Set(['.yml', '.yaml', '.json'])

/**
 * Local watcher debounce. This is a refresh cadence, not a deployment
 * difference, so it stays out of `Config`.
 */
export const RELOAD_DEBOUNCE_MS = 150

/** One loaded definition file, either usable or diagnosed. */
export type AgentRegistryEntry =
  | { readonly status: 'valid', readonly file: string, readonly spec: AgentSpec }
  | { readonly status: 'invalid', readonly file: string, readonly error: string }

/** Read-only view of the current agent definitions. */
export interface AgentRegistry {
  /** Every definition file found by the last reload, including invalid ones. */
  listAgents(): readonly AgentRegistryEntry[]
  /** Resolve one agent by id against the current snapshot. */
  resolveAgent(id: string): AgentSpec | undefined
  /**
   * Observe snapshot reloads: the listener runs after each reload that
   * replaces the entries. The returned disposer removes the listener.
   */
  onChange(listener: () => void): () => void
}

/** The part of a Cordis context the registry registers its effects on. */
export interface EffectScope {
  effect(callback: () => () => void): unknown
}

/** Render an unknown thrown value as a readable message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Format zod issues as `path: message` pairs for a readable file error. */
function formatIssues(error: { issues: { path: PropertyKey[], message: string }[] }): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ')
}

/** Parse one definition document according to its extension. */
function parseDocument(text: string, file: string): unknown {
  return extname(file) === '.json' ? JSON.parse(text) : loadYaml(text)
}

/** File whose presence marks a directory as the shipped built-in agents directory. */
export const BUILT_IN_CURATOR_MARKER = 'memory-curator.yml'

/**
 * Locate the shipped built-in agents directory by walking up from this module
 * (works from the source tree and from the bundled `lib/index.js`).
 * @returns the directory holding `agents/` with the shipped curator, or
 *   undefined when the marker is missing (package unpacked without `agents/`).
 */
export function resolveBuiltInAgentsDir(): string | undefined {
  let current = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(current, 'agents', BUILT_IN_CURATOR_MARKER)
    if (existsSync(candidate)) return join(current, 'agents')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * Merge the built-in entries under the user's: a user definition with the same
 * id shadows the built-in one; the built-in entry survives otherwise.
 * @param user - entries from the watched user directory.
 * @param builtIn - entries from the shipped directory.
 * @returns the merged snapshot in user-then-builtin order.
 */
function mergeBuiltIn(user: AgentRegistryEntry[], builtIn: AgentRegistryEntry[]): AgentRegistryEntry[] {
  const userOwnerIds = new Set(
    user.filter((entry) => entry.status === 'valid').map((entry) => entry.spec.id),
  )
  const shipped = builtIn.filter((entry) => {
    if (entry.status !== 'valid') return false
    return !userOwnerIds.has(entry.spec.id)
  })
  return [...user, ...shipped]
}

/**
 * Read every definition file in one directory.
 * @param dir - absolute agents directory.
 * @returns one entry per accepted-extension file, sorted by file name.
 */
export function loadAgentDirectory(dir: string): AgentRegistryEntry[] {
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && AGENT_FILE_EXTENSIONS.has(extname(entry.name)))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    // A removed directory is an empty catalog; anything else is a real failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const entries: AgentRegistryEntry[] = []
  const owners = new Map<string, string>()
  for (const file of names) {
    let parsed: unknown
    try {
      parsed = parseDocument(readFileSync(join(dir, file), 'utf8'), file)
    } catch (error) {
      entries.push({ status: 'invalid', file, error: `${file}: ${(error as Error).message}` })
      continue
    }
    const result = AgentSpecSchema.safeParse(parsed)
    if (!result.success) {
      entries.push({ status: 'invalid', file, error: `${file}: ${formatIssues(result.error)}` })
      continue
    }
    const previous = owners.get(result.data.id)
    if (previous !== undefined) {
      entries.push({ status: 'invalid', file, error: `${file}: duplicate agent id "${result.data.id}" (already defined in ${previous})` })
      continue
    }
    owners.set(result.data.id, file)
    entries.push({ status: 'valid', file, spec: result.data })
  }
  return entries
}

/**
 * Create the live agent registry and register its watcher on `scope`.
 *
 * The directory is created when missing so the watcher always has a target;
 * a path that exists as a non-directory fails plugin load.
 * @param scope - effect scope owning the watcher lifetime.
 * @param config - the plugin configuration slice holding `agentsDir`.
 * @param builtIn - the shipped built-in directory, when present. A broken
 *   built-in file throws here: it is a packaging bug, not user data.
 * @param onError - sink for a reload or watcher failure; a failed reload keeps
 *   the previous entries and notifies no listener. The initial load stays
 *   fail-loud and runs during plugin load.
 * @returns the registry backed by an initially loaded snapshot.
 */
export function createAgentRegistry(
  scope: EffectScope,
  config: Pick<Config, 'agentsDir'>,
  builtIn?: { readonly dir: string },
  onError?: (message: string) => void,
): AgentRegistry {
  const dir = resolve(process.cwd(), config.agentsDir)
  mkdirSync(dir, { recursive: true })

  const builtInEntries = builtIn === undefined ? [] : (() => {
    const loaded = loadAgentDirectory(builtIn.dir)
    const broken = loaded.find((entry) => entry.status === 'invalid')
    if (broken !== undefined) throw new Error(`built-in agent definition is invalid: ${broken.error}`)
    return loaded
  })()
  let entries = mergeBuiltIn(loadAgentDirectory(dir), builtInEntries)
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const reload = (): void => {
    let next: AgentRegistryEntry[]
    try {
      next = mergeBuiltIn(loadAgentDirectory(dir), builtInEntries)
    } catch (error) {
      // Reload runs from a debounce timer and a watcher error handler, so a
      // rethrow here would escape as an uncaught exception. Keep the previous
      // snapshot, report the failure, and leave listeners un-notified.
      onError?.(`agent directory reload failed: ${describe(error)}`)
      return
    }
    entries = next
    for (const listener of listeners) listener()
  }
  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      reload()
    }, RELOAD_DEBOUNCE_MS)
  }

  scope.effect(() => {
    const watcher = watch(dir, { persistent: false }, schedule)
    watcher.on('error', (error) => {
      onError?.(`agent directory watcher failed: ${describe(error)}`)
      reload()
    })
    return () => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      watcher.close()
    }
  })

  return {
    listAgents: () => entries,
    resolveAgent: (id) => {
      const entry = entries.find((candidate) => candidate.status === 'valid' && candidate.spec.id === id)
      return entry?.status === 'valid' ? entry.spec : undefined
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
