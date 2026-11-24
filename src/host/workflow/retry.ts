/**
 * Retry policy for node failures.
 *
 * Two independent gates: the failure class, and — for tool failures — whether
 * the reporting code is whitelisted in `Config.retryableToolErrors`. The
 * whitelist defaults to empty, so tool errors are never retried unless a
 * deployment opts specific codes in; `deterministic` and `auth` failures are
 * never retried because repeating them cannot change the outcome.
 */
import type { NodeErrorClass } from '../events.ts'

/** Why a retry was refused, for the journal and the run report. */
export type RetryRefusal =
  | 'not-retryable-class'
  | 'attempts-exhausted'
  | 'tool-error-not-whitelisted'

/** What one retry decision needs. */
export interface RetryDecisionInput {
  readonly errorClass: NodeErrorClass
  /** Code reported by the failing tool, when the failure came from a tool. */
  readonly errorCode?: string
  /** Attempts made so far, one-based. */
  readonly attempt: number
  /** Attempt cap for this node (`node.maxAttempts ?? document.defaults.maxAttempts`). */
  readonly maxAttempts: number
  /** Tool error codes allowed to retry; empty means tool errors never retry. */
  readonly retryableToolErrors: readonly string[]
}

/** The retry decision plus the reason when it is refused. */
export type RetryDecision =
  | { readonly retry: true }
  | { readonly retry: false, readonly reason: RetryRefusal }

/** Failure classes that can never succeed on a retry. */
const PERMANENT_CLASSES: ReadonlySet<NodeErrorClass> = new Set(['deterministic', 'auth'])

/**
 * Decide whether one failed node attempt may be retried.
 * @param input - the failure class and code, the attempt count, and the policy.
 * @returns the decision and, when refused, the reason.
 */
export function shouldRetry(input: RetryDecisionInput): RetryDecision {
  if (PERMANENT_CLASSES.has(input.errorClass)) return { retry: false, reason: 'not-retryable-class' }
  if (input.errorCode !== undefined && !input.retryableToolErrors.includes(input.errorCode)) {
    return { retry: false, reason: 'tool-error-not-whitelisted' }
  }
  if (input.attempt >= input.maxAttempts) return { retry: false, reason: 'attempts-exhausted' }
  return { retry: true }
}

/**
 * The attempt cap for one node.
 * @param nodeMaxAttempts - the node's own cap, when set.
 * @param documentDefault - the document-wide default.
 * @returns the cap the retry policy uses.
 */
export function attemptCap(nodeMaxAttempts: number | undefined, documentDefault: number): number {
  return nodeMaxAttempts ?? documentDefault
}
