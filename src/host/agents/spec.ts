/**
 * Declarative agent definition loaded from `agentsDir`.
 *
 * The spec maps onto `SubagentStartRequest`: `provider` selects the subagent
 * backend, `model`/`reasoningEffort`/`maxTokens` become `agentOptions`, and
 * `agentPreset`/`cwd`/`prompt`/`outputSchema` pass through. Tool and persona
 * trimming belongs to preset composition, so this schema has no `tools` or
 * `skills` fields.
 */
import { z } from 'zod'

export const AgentSpecSchema = z.object({
  /** Stable lowercase identifier used by tools, `@` mentions, and workflow nodes. */
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  /** Display name shown in the `@` menu and tool listings. */
  name: z.string().min(1),
  /** One-line capability summary; never the prompt itself. */
  description: z.string().min(1),
  /** System prompt delivered to the child activation. */
  prompt: z.string().min(1),
  /** Registered subagent provider name (`spawn`, `fork`, ...). */
  provider: z.string().default('spawn'),
  /** Preset id granting the child its tools and persona (`spawn` only). */
  agentPreset: z.string().optional(),
  /** Model id for the child; omitted means the child-loop default. */
  model: z.string().optional(),
  /** Reasoning effort forwarded to the child model selection. */
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  /** Output token cap forwarded to the child model selection. */
  maxTokens: z.number().int().positive().optional(),
  /** Working directory for the child activation. */
  cwd: z.string().optional(),
  /** Prefix the child prompt with a read-only instruction. */
  readOnly: z.boolean().default(true),
  /** Plugin-owned timeout for one activation, in milliseconds. */
  timeoutMs: z.number().int().positive().default(600_000),
  /** JSON schema the child result must satisfy. */
  outputSchema: z.record(z.string(), z.unknown()).optional(),
})

/** One validated agent definition. */
export type AgentSpec = z.infer<typeof AgentSpecSchema>
