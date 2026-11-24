import { describe, expect, it } from 'vitest'
import {
  isXlEventType,
  PLUGIN_RECORD_PATTERN,
  XL_EVENTS,
  XL_EVENT_TYPES,
  XL_VERSIONED,
} from '../src/host/events.ts'

const EXPECTED = [
  'plugin:xl-build/catalog',
  'plugin:xl-build/edge-transfer',
  'plugin:xl-build/memory-updated',
  'plugin:xl-build/mention-resolved',
  'plugin:xl-build/mention-unresolved',
  'plugin:xl-build/node-delta',
  'plugin:xl-build/node-end',
  'plugin:xl-build/node-error',
  'plugin:xl-build/node-input',
  'plugin:xl-build/node-start',
  'plugin:xl-build/run-end',
  'plugin:xl-build/run-start',
]

describe('xl-build records', () => {
  it('declares exactly the planned record names', () => {
    expect([...Object.values(XL_EVENTS)].sort()).toEqual(EXPECTED)
  })

  it('uses the plugin record grammar for every name', () => {
    for (const name of Object.values(XL_EVENTS)) {
      expect(name).toMatch(/^plugin:xl-build\//)
      expect(name).toMatch(PLUGIN_RECORD_PATTERN)
    }
  })

  it('marks every payload as versioned', () => {
    expect(Object.keys(XL_VERSIONED).sort()).toEqual(Object.keys(XL_EVENTS).sort())
    expect(Object.values(XL_VERSIONED).every((flag) => flag === true)).toBe(true)
  })

  it('narrows stored record names to the declared union', () => {
    for (const name of XL_EVENT_TYPES) {
      expect(isXlEventType(name)).toBe(true)
    }
    expect(isXlEventType('plugin:xl-build/unknown')).toBe(false)
    expect(isXlEventType('agent-multi/run-start')).toBe(false)
  })
})
