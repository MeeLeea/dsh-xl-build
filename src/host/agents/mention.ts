/**
 * Pure mention parsing for the `@subagent` entry: it recognizes the canonical
 * `<xl-agent id="x" />` token and hand-typed `@label`, resolves each mention
 * against the live agent catalog, and slices the task literal each mention
 * consumes.
 *
 * Host-independent on purpose: the `agent/pre-step` handler and the specs call
 * this one implementation, so the boundary rules cannot drift apart.
 */
import type { MentionUnresolvedReason } from '../events.ts'

/** The agent identity fields mention matching needs. */
export interface MentionAgent {
  readonly id: string
  readonly name: string
}

/** A resolved target or the reason it could not be resolved. */
export type MentionResolution =
  | { readonly kind: 'resolved', readonly agentId: string }
  | { readonly kind: 'unresolved', readonly reason: MentionUnresolvedReason }

/** One mention occurrence plus the draft span it consumes. */
export interface ParsedMention {
  /** Zero-based position among this text's mentions, in appearance order. */
  readonly segmentIndex: number
  /** Mention text exactly as written. */
  readonly raw: string
  /** Offset (UTF-16 code units) where the mention starts. */
  readonly start: number
  /** Offset one past the mention's last character. */
  readonly end: number
  /** Draft text between this mention and the next, trimmed of surrounding whitespace. */
  readonly task: string
  readonly resolution: MentionResolution
}

/**
 * The canonical mention token, tolerant of whitespace the composer or a user
 * may have dropped (`<xl-agent id="x"/>`).
 */
export const XL_MENTION_TOKEN_PATTERN: RegExp = /<\s*xl-agent\s+id="([^"]+)"\s*\/>/g

/** Characters that may introduce a hand-typed mention. */
const HANDLE_PREFIX_PATTERN = /[\s([{（"'`，,。;；:：、]/

/** The target run of a hand-typed mention. */
const HANDLE_RUN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*/

interface Candidate {
  readonly start: number
  readonly end: number
  readonly raw: string
  readonly resolution: MentionResolution
}

/** Resolve one written target against the agent catalog. */
function resolveTarget(target: string, agents: readonly MentionAgent[]): MentionResolution {
  for (const agent of agents) {
    if (agent.id === target) return { kind: 'resolved', agentId: agent.id }
  }
  const named = agents.filter((agent) => agent.name === target)
  const [only] = named
  if (named.length === 1 && only !== undefined) return { kind: 'resolved', agentId: only.id }
  if (named.length > 1) return { kind: 'unresolved', reason: 'ambiguous-label' }
  return { kind: 'unresolved', reason: 'unknown-agent' }
}

/** Longest display-name prefix of `rest`, for labels that contain spaces. */
function longestLabelPrefix(
  rest: string,
  agents: readonly MentionAgent[],
): { text: string, resolution: MentionResolution } | undefined {
  let best: { text: string, resolution: MentionResolution } | undefined
  for (const agent of agents) {
    if (agent.name.length === 0 || !rest.startsWith(agent.name)) continue
    if (best !== undefined && best.text.length >= agent.name.length) continue
    const named = agents.filter((candidate) => candidate.name === agent.name)
    best = {
      text: agent.name,
      resolution: named.length > 1
        ? { kind: 'unresolved', reason: 'ambiguous-label' }
        : { kind: 'resolved', agentId: agent.id },
    }
  }
  return best
}

/** Collect every mention candidate in appearance order. */
function collectCandidates(text: string, agents: readonly MentionAgent[]): Candidate[] {
  const candidates: Candidate[] = []
  // `matchAll` clones a global pattern, so the shared constant stays stateless.
  for (const match of text.matchAll(XL_MENTION_TOKEN_PATTERN)) {
    const index = match.index
    candidates.push({
      start: index,
      end: index + match[0].length,
      raw: match[0],
      resolution: resolveTarget(match[1] ?? '', agents),
    })
  }

  for (let index = text.indexOf('@'); index >= 0; index = text.indexOf('@', index + 1)) {
    if (index > 0 && !HANDLE_PREFIX_PATTERN.test(text[index - 1] ?? '')) continue
    if (candidates.some((candidate) => index >= candidate.start && index < candidate.end)) continue
    const rest = text.slice(index + 1)
    const handle = HANDLE_RUN_PATTERN.exec(rest)?.[0] ?? ''
    if (handle.length > 0) {
      const resolution = resolveTarget(handle, agents)
      if (resolution.kind === 'resolved' || resolution.reason === 'ambiguous-label') {
        candidates.push({ start: index, end: index + 1 + handle.length, raw: text.slice(index, index + 1 + handle.length), resolution })
        continue
      }
    }
    const label = longestLabelPrefix(rest, agents)
    if (label !== undefined) {
      candidates.push({
        start: index,
        end: index + 1 + label.text.length,
        raw: text.slice(index, index + 1 + label.text.length),
        resolution: label.resolution,
      })
      continue
    }
    if (handle.length > 0) {
      // A hand-typed target that resolves to nothing is still a mention the
      // user wrote; reporting it keeps the failure visible instead of silent.
      candidates.push({
        start: index,
        end: index + 1 + handle.length,
        raw: text.slice(index, index + 1 + handle.length),
        resolution: { kind: 'unresolved', reason: 'unknown-agent' },
      })
    }
  }

  return candidates.sort((left, right) => left.start - right.start)
}

/**
 * Parse every mention in one text and slice the task each consumes.
 * @param text - one message's text content.
 * @param agents - the live agent catalog.
 * @returns mentions in appearance order, each with its own task literal.
 */
export function parseMentions(text: string, agents: readonly MentionAgent[]): ParsedMention[] {
  const candidates = collectCandidates(text, agents)
  return candidates.map((candidate, segmentIndex) => {
    const next = candidates[segmentIndex + 1]
    return {
      segmentIndex,
      raw: candidate.raw,
      start: candidate.start,
      end: candidate.end,
      task: text.slice(candidate.end, next?.start ?? text.length).trim(),
      resolution: candidate.resolution,
    }
  })
}
