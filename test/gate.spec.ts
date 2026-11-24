import { describe, expect, it } from 'vitest'
import { createActivationGate } from '../src/host/agents/gate.ts'
import type { GatedActivation } from '../src/host/agents/gate.ts'

/** A never-settling activation whose slot the test releases explicitly. */
function pendingActivation(childId: string): GatedActivation {
  return { childId, dispose: async () => {}, result: new Promise(() => {}) }
}

describe('activation gate', () => {
  it('admits up to the limit and starts the rest FIFO as slots free', () => {
    const gate = createActivationGate(2)
    const started: string[] = []
    const releases: (() => void)[] = []
    const { signal } = new AbortController()
    const start = (id: string): Promise<GatedActivation> => gate.start(signal, async (release) => {
      started.push(id)
      releases.push(release)
      return pendingActivation(id)
    })

    void start('a')
    void start('b')
    void start('c')
    expect(started).toEqual(['a', 'b'])
    expect(gate.activeCount()).toBe(2)

    releases[0]?.()
    expect(started).toEqual(['a', 'b', 'c'])
    expect(gate.activeCount()).toBe(2)

    releases[1]?.()
    releases[2]?.()
    expect(gate.activeCount()).toBe(0)
  })

  it('releases the slot when a start rejects', async () => {
    const gate = createActivationGate(1)
    await expect(gate.start(new AbortController().signal, async () => {
      throw new Error('provider refused')
    })).rejects.toThrow('provider refused')
    expect(gate.activeCount()).toBe(0)
  })

  it('drops a queued start when its caller aborts', async () => {
    const gate = createActivationGate(1)
    const first = new AbortController()
    const releases: (() => void)[] = []
    void gate.start(first.signal, async (release) => {
      releases.push(release)
      return pendingActivation('a')
    })

    let startedQueued = false
    const queued = new AbortController()
    const queuedStart = gate.start(queued.signal, async () => {
      startedQueued = true
      return pendingActivation('b')
    })
    queued.abort(new Error('cancelled while queued'))
    await expect(queuedStart).rejects.toThrow('cancelled while queued')

    releases[0]?.()
    expect(startedQueued).toBe(false)
    expect(gate.activeCount()).toBe(0)
  })

  it('rejects an already-aborted start without calling the starter', async () => {
    const gate = createActivationGate(1)
    const controller = new AbortController()
    controller.abort(new Error('aborted before start'))
    let called = false
    await expect(gate.start(controller.signal, async () => {
      called = true
      return pendingActivation('a')
    })).rejects.toThrow('aborted before start')
    expect(called).toBe(false)
  })
})
