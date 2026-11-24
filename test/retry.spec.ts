import { describe, expect, it } from 'vitest'
import { attemptCap, shouldRetry } from '../src/host/workflow/retry.ts'

/** A retry decision for one failure. */
function decide(errorClass: Parameters<typeof shouldRetry>[0]['errorClass'], extra: Partial<Parameters<typeof shouldRetry>[0]> = {}) {
  return shouldRetry({ errorClass, attempt: 1, maxAttempts: 2, retryableToolErrors: [], ...extra })
}

describe('shouldRetry', () => {
  it('retries a transient or timeout failure while attempts remain', () => {
    expect(decide('transient')).toEqual({ retry: true })
    expect(decide('timeout')).toEqual({ retry: true })
    expect(decide('transient', { attempt: 2 })).toEqual({ retry: false, reason: 'attempts-exhausted' })
  })

  it('never retries a permanent failure class', () => {
    expect(decide('deterministic')).toEqual({ retry: false, reason: 'not-retryable-class' })
    expect(decide('auth')).toEqual({ retry: false, reason: 'not-retryable-class' })
  })

  it('retries a tool error only when its code is whitelisted', () => {
    expect(decide('transient', { errorCode: 'E_TOOL' })).toEqual({ retry: false, reason: 'tool-error-not-whitelisted' })
    expect(decide('transient', { errorCode: 'E_TOOL', retryableToolErrors: ['E_OTHER'] }))
      .toEqual({ retry: false, reason: 'tool-error-not-whitelisted' })
    expect(decide('transient', { errorCode: 'E_TOOL', retryableToolErrors: ['E_TOOL'] })).toEqual({ retry: true })
  })

  it('reports the attempt cap before the whitelist and the cap independently', () => {
    // A whitelisted transient failure still stops at the cap.
    expect(decide('transient', { errorCode: 'E_TOOL', retryableToolErrors: ['E_TOOL'], attempt: 3, maxAttempts: 3 }))
      .toEqual({ retry: false, reason: 'attempts-exhausted' })
    expect(attemptCap(undefined, 2)).toBe(2)
    expect(attemptCap(5, 2)).toBe(5)
  })
})
