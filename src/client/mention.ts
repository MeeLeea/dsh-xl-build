/**
 * The client `@` source for xl-build agents.
 *
 * Candidates come from the `xlBuild` Session projection, never from the host
 * registry: the browser bundle only sees the wire view. The projection value
 * is validated locally against the catalog subset, so a foreign or older view
 * degrades to "no candidates" instead of breaking the menu.
 *
 * Reference text is the canonical `<xl-agent id="x" />` token the host parses;
 * the clipboard projection is `@id`, which the same parser accepts.
 */
import type {
  InputTriggerCandidate,
  InputTriggerSource,
  ReferenceCodec,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { z } from 'zod'

/** Projection key the host unit registers; a spec asserts the two stay equal. */
export const CATALOG_PROJECTION_KEY = 'xlBuild'

/** Reference source name; also the `source` recorded on every inserted chip. */
export const XL_AGENT_REFERENCE_SOURCE = 'xl-agent'

const CatalogAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
})

/** The catalog subset this source consumes from the projection value. */
const CatalogProjectionSchema = z.object({
  catalog: z.object({ agents: z.array(CatalogAgentSchema) }),
})

export type CatalogAgent = z.infer<typeof CatalogAgentSchema>

/**
 * Read the agent catalog out of one projection snapshot value.
 * @param value - the raw `xlBuild` projection value, or undefined while absent.
 * @returns the agents, or an empty list when the value is absent or foreign.
 */
export function catalogAgentsFromProjection(value: unknown): CatalogAgent[] {
  const parsed = CatalogProjectionSchema.safeParse(value)
  return parsed.success ? parsed.data.catalog.agents : []
}

/**
 * Filter the catalog into menu candidates.
 * @param agents - the session's catalog agents.
 * @param query - the text typed after `@`.
 * @param section - localized group heading.
 * @returns candidates matching the id or display name.
 */
export function mentionCandidates(
  agents: readonly CatalogAgent[],
  query: string,
  section: string,
): InputTriggerCandidate[] {
  const needle = query.trim().toLowerCase()
  return agents
    .filter((agent) => needle === ''
      || agent.id.toLowerCase().includes(needle)
      || agent.name.toLowerCase().includes(needle))
    .map((agent) => ({
      name: agent.id,
      label: agent.name,
      description: agent.description,
      section,
    }))
}

/** Clipboard and model serialization for one agent reference. */
export const XL_AGENT_CODEC: ReferenceCodec = {
  clipboardText: (ref) => `@${ref}`,
  serialize: async (ref, signal) => {
    signal.throwIfAborted()
    return `<xl-agent id="${ref}" />`
  },
}

/** What the source needs from the client plugin that owns it. */
export interface MentionSourceDeps {
  /** Catalog agents for one session, read from the projection snapshot. */
  agentsFor: (sessionId: SessionId) => readonly CatalogAgent[]
  /** Localized heading shared by this source's candidates. */
  section: () => string
}

/**
 * Build the `@` trigger source.
 * @param deps - the projection reader and the localized section heading.
 * @returns the source to register on `ctx.inputTriggers`.
 */
export function createMentionSource(deps: MentionSourceDeps): InputTriggerSource {
  return {
    trigger: '@',
    name: XL_AGENT_REFERENCE_SOURCE,
    order: 20,
    candidates: (session, req) => Promise.resolve(
      mentionCandidates(deps.agentsFor(session.sessionId), req.query, deps.section()),
    ),
    onPick: (pick) => {
      const ref = pick.candidate.name
      return {
        insert: {
          source: XL_AGENT_REFERENCE_SOURCE,
          ref,
          label: pick.candidate.label ?? ref,
          clipboardText: `@${ref}`,
        },
      }
    },
    codec: XL_AGENT_CODEC,
  }
}
