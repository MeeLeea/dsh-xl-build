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
import type { CatalogPayload, CatalogWorkflow } from './events.ts'
import type { AgentRegistry } from './agents/registry.ts'
import { loadWorkflowDirectory } from './workflow/loaders.ts'
import { toMermaid } from './workflow/mermaid.ts'

/** Build the catalog from the live registry and the workflow directory. */
export function buildCatalog(
  registry: Pick<AgentRegistry, 'listAgents'>,
  workflowsDir: string,
): CatalogPayload {
  const workflows: CatalogWorkflow[] = loadWorkflowDirectory(workflowsDir)
    .flatMap((entry) => entry.status === 'valid'
      ? [{
        id: entry.document.id,
        name: entry.document.name,
        ...entry.document.description !== undefined ? { description: entry.document.description } : {},
        mermaid: toMermaid(entry.document),
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
 * @param deps - the live agent registry and the absolute workflows directory.
 * @returns the publisher used at step start.
 */
export function createCatalogPublisher(deps: {
  registry: Pick<AgentRegistry, 'listAgents'>
  workflowsDir: string
}): CatalogPublisher {
  const published = new WeakMap<object, string>()
  return {
    ensure: (sessionKey, append) => {
      const catalog = buildCatalog(deps.registry, deps.workflowsDir)
      const fingerprint = catalogFingerprint(catalog)
      if (published.get(sessionKey) === fingerprint) return
      published.set(sessionKey, fingerprint)
      append(catalog)
    },
  }
}
