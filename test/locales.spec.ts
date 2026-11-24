import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

/** Flatten a dictionary into dotted keys so nested maps still compare by leaf. */
function flat(dict: Record<string, unknown>, prefix = ''): Map<string, string> {
  const leaves = new Map<string, string>()
  for (const [key, value] of Object.entries(dict)) {
    const path = prefix === '' ? key : prefix + '.' + key
    if (typeof value === 'string') leaves.set(path, value)
    else for (const [child, leaf] of flat(value as Record<string, unknown>, path)) leaves.set(child, leaf)
  }
  return leaves
}

describe('xl-build locales', () => {
  it('keeps zh and en key sets identical', () => {
    const zhKeys = [...flat(zh).keys()].sort()
    const enKeys = [...flat(en).keys()].sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('keeps every leaf a non-empty string in both dictionaries', () => {
    for (const dict of [zh, en] as const) {
      for (const [key, value] of flat(dict)) {
        expect(value, key).not.toBe('')
      }
    }
  })
})
