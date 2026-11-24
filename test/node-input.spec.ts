import { describe, expect, it } from 'vitest'
import { composeNodeInput } from '../src/host/workflow/node-input.ts'

const EDGE = {
  edgeId: 'e1',
  from: 'aa',
  to: 'bb',
  format: 'text' as const,
  value: 'payload',
  maxBytes: 1_000,
}

describe('composeNodeInput', () => {
  it('returns the node text alone when nothing feeds it', () => {
    expect(composeNodeInput('do the work', [])).toEqual({ text: 'do the work', edges: [] })
  })

  it('omits an empty node text and keeps only the envelopes', () => {
    expect(composeNodeInput('', [EDGE]).text).toContain('[edge aa -> bb | format=text | 7B]')
    expect(composeNodeInput('', [EDGE]).text.startsWith('[edge')).toBe(true)
  })

  it('places the node text first and envelopes after it', () => {
    const result = composeNodeInput('do the work', [EDGE])
    expect(result.text).toBe('do the work\n\n[edge aa -> bb | format=text | 7B]\npayload\n[/edge]')
    expect(result.edges).toEqual([{ edgeId: 'e1', from: 'aa', format: 'text', bytes: 7 }])
  })

  it('keeps inbound order and accounts for every edge', () => {
    const second = { ...EDGE, edgeId: 'e2', from: 'cc', value: 'more' }
    const result = composeNodeInput('', [EDGE, second])
    expect(result.edges.map((edge) => edge.edgeId)).toEqual(['e1', 'e2'])
    expect(result.text.indexOf('[edge aa')).toBeLessThan(result.text.indexOf('[edge cc'))
  })

  it('passes the byte budget through so a trimmed payload is marked', () => {
    const tight = { ...EDGE, value: 'abcdefghij', maxBytes: 4 }
    const result = composeNodeInput('', [tight])
    expect(result.text).toContain('[truncated: kept 4 of 10 bytes]')
    expect(result.edges[0]?.bytes).toBe(10)
  })
})
