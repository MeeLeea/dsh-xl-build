/**
 * The agent/workflow catalog published into each Session as a durable record.
 *
 * The client `@` source and the run board both read candidates from the
 * `xlBuild` projection, and a projection can only fold logged events — so the
 * host writes one `catalog` record per Session whenever the catalog differs
 * from what that Session already carries. Agents appear with id, name, and
 * description only; prompts never leave the host. Workflows carry the
 * deterministic Mermaid projection of the current document so the client can
 * export it without regenerating anything.
 */
import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { CatalogPayload, CatalogWorkflow } from './events.ts'
import type { AgentRegistry } from './agents/registry.ts'
import { loadMergedWorkflowCatalog } from './workflow/builtins.ts'
import { WORKFLOW_FILE_EXTENSIONS } from './workflow/loaders.ts'
import { toMermaid } from './workflow/mermaid.ts'

/** The live registry and the watched workflow directory a catalog is derived from. */
export interface CatalogSourceDeps {
  /** Live agent registry supplying the agent entries. */
  readonly registry: Pick<AgentRegistry, 'listAgents'>
  /** Absolute directory holding the user's workflow files. */
  readonly workflowsDir: string
}

/** Build the catalog from the live registry and the merged workflow directories. */
export function buildCatalog(
  registry: Pick<AgentRegistry, 'listAgents'>,
  workflowsDir: string,
  builtInWorkflowsDir?: string,
): CatalogPayload {
  const workflows: CatalogWorkflow[] = loadMergedWorkflowCatalog(workflowsDir, builtInWorkflowsDir)
    .entries
    .flatMap((entry) => entry.status === 'valid'
      ? [{
        id: entry.document.id,
        name: entry.document.name,
        ...entry.document.description !== undefined ? { description: entry.document.description } : {},
        mermaid: toMermaid(entry.document),
        nodes: entry.document.nodes.map((node) => ({
          id: node.id,
          kind: node.kind,
          ...node.kind === 'loop' ? { body: node.body } : {},
        })),
        edges: entry.document.edges.map((edge) => ({
          id: edge.id,
          from: edge.from,
          to: edge.to,
          kind: edge.kind,
        })),
      }]
      : [])
  return {
    version: 1,
    agents: registry.listAgents().flatMap((entry) => entry.status === 'valid'
      ? [{ id: entry.spec.id, name: entry.spec.name, description: entry.spec.description }]
      : []),
    workflows,
  }
}

/**
 * Fingerprint one catalog for change detection.
 * @param catalog - the catalog to fingerprint.
 * @returns a stable string that changes only when the catalog content changes.
 */
export function catalogFingerprint(catalog: CatalogPayload): string {
  return JSON.stringify(catalog)
}

/**
 * Cheap source signature of the agent registry and the watched workflow
 * directory. It is computed before any file is read, parsed, validated, or
 * rendered, so the per-step guard costs one directory scan. The shipped
 * `builtInWorkflowsDir` is deliberately absent: it is static packaging content
 * that cannot change while the process runs.
 * @param deps - the live agent registry and the watched workflow directory.
 * @returns a stable string that changes when the sources change.
 */
export function catalogSourceFingerprint(deps: CatalogSourceDeps): string {
  const agents = deps.registry.listAgents().map((entry) => entry.status === 'valid'
    ? [entry.status, entry.file, entry.spec.id, entry.spec.name, entry.spec.description]
    : [entry.status, entry.file, entry.error])
  const workflows = workflowDirectorySignature(deps.workflowsDir)
  return JSON.stringify({ agents, workflows })
}

/** Name, mtime, and size of every accepted workflow file; a missing directory is empty. */
function workflowDirectorySignature(workflowsDir: string): (string | number)[][] {
  let names: string[]
  try {
    names = readdirSync(workflowsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && WORKFLOW_FILE_EXTENSIONS.has(extname(entry.name)))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    // A removed directory is an empty source; anything else is a real failure.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.map((name) => {
    const stat = statSync(join(workflowsDir, name))
    return [name, stat.mtimeMs, stat.size]
  })
}

/** Writes the catalog into a Session exactly when it changed. */
export interface CatalogPublisher {
  /**
   * Publish the current catalog for one Session when it differs from the last
   * catalog written for that Session.
   * @param sessionKey - stable identity of the Session.
   * @param append - durable write performed by the composition root.
   */
  ensure(sessionKey: object, append: (catalog: CatalogPayload) => void): void
}

/**
 * Create the per-Session catalog publisher.
 * @param deps - the live agent registry, the watched workflow directory, and
 *   the optional shipped workflow directory appended under it.
 * @returns the publisher used at step start.
 */
export function createCatalogPublisher(deps: CatalogSourceDeps & {
  builtInWorkflowsDir?: string
}): CatalogPublisher {
  const published = new WeakMap<object, { source: string, content: string }>()
  return {
    ensure: (sessionKey, append) => {
      const source = catalogSourceFingerprint(deps)
      const previous = published.get(sessionKey)
      if (previous !== undefined && previous.source === source) return
      const catalog = buildCatalog(deps.registry, deps.workflowsDir, deps.builtInWorkflowsDir)
      const content = catalogFingerprint(catalog)
      published.set(sessionKey, { source, content })
      // An unchanged content fingerprint (e.g. a touch) still refreshes the
      // source, but publishing the same catalog again would be a no-op record.
      if (previous !== undefined && previous.content === content) return
      append(catalog)
    },
  }
}
