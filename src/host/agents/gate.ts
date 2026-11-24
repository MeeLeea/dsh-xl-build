/**
 * Conversation-level activation gate for `xl_agent_run`.
 *
 * A model can fan out many delegations in one message; the gate admits at most
 * `maxConcurrentAgentTools` unsettled activations and queues the rest FIFO.
 * A slot is released when the activation settles or its caller aborts while
 * still queued. Aborting a queued start drops it without starting anything.
 */

/** A started activation with the exact disposal that settles its execution. */
export interface ActivationHandle {
  readonly childId: string
  dispose(): Promise<void>
}

/** A started activation plus the promise that reports when it settles. */
export interface GatedActivation<R = unknown> extends ActivationHandle {
  /** Settles when the activation's teardown and notifications complete. */
  readonly result: Promise<R>
}

interface Waiting {
  readonly signal: AbortSignal
  readonly starter: (release: () => void) => Promise<GatedActivation<unknown>>
  readonly resolve: (activation: GatedActivation<unknown>) => void
  readonly reject: (reason: unknown) => void
  readonly onAbort: () => void
}

/** Admission control for activations started through the conversation tool. */
export interface ActivationGate {
  /**
   * Start one activation once a slot is free.
   * @param signal - caller cancellation; aborting a queued start drops it.
   * @param starter - starts the activation and receives its slot release.
   * @returns the started activation, or a rejection when the signal aborts first.
   */
  start<R>(signal: AbortSignal, starter: (release: () => void) => Promise<GatedActivation<R>>): Promise<GatedActivation<R>>
  /** Number of activations currently holding a slot. */
  activeCount(): number
}

/**
 * Create the conversation-level activation gate.
 * @param maxConcurrent - unsettled activations admitted at once.
 * @returns the gate used by the agent runner's conversation path.
 */
export function createActivationGate(maxConcurrent: number): ActivationGate {
  let active = 0
  const waiting: Waiting[] = []

  /** Release one slot and admit the next queued start. */
  function release(): void {
    active -= 1
    pump()
  }

  /** Admit queued starts while slots remain. */
  function pump(): void {
    while (active < maxConcurrent && waiting.length > 0) {
      const next = waiting.shift()
      if (next === undefined) return
      next.signal.removeEventListener('abort', next.onAbort)
      if (next.signal.aborted) {
        next.reject(next.signal.reason)
        continue
      }
      active += 1
      next.starter(release).then(next.resolve, (error: unknown) => {
        release()
        next.reject(error)
      })
    }
  }

  return {
    activeCount: () => active,
    start: <R>(signal: AbortSignal, starter: (release: () => void) => Promise<GatedActivation<R>>) => new Promise<GatedActivation<R>>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      if (active < maxConcurrent) {
        active += 1
        starter(release).then(resolve, (error: unknown) => {
          release()
          reject(error)
        })
        return
      }
      // The FIFO entry is erased to the queue's `unknown` read type; each
      // entry's own promise keeps its `R`, so this cast loses nothing.
      const entry: Waiting = {
        signal,
        starter: starter as (release: () => void) => Promise<GatedActivation<unknown>>,
        resolve: resolve as (activation: GatedActivation<unknown>) => void,
        reject,
        onAbort: () => {
          const index = waiting.indexOf(entry)
          if (index >= 0) waiting.splice(index, 1)
          reject(signal.reason)
        },
      }
      waiting.push(entry)
      signal.addEventListener('abort', entry.onAbort, { once: true })
    }),
  }
}
