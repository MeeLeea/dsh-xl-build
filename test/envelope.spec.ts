import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  renderEdgeEnvelope,
  serializeEdgeValue,
  TRUNCATION_MARKER,
} from '../src/host/workflow/envelope.ts'

describe('formatBytes', () => {
  it('shows raw bytes below a kilobyte and one decimal above it', () => {
    expect(formatBytes(0)).toBe('0B')
    expect(formatBytes(512)).toBe('512B')
    expect(formatBytes(1024)).toBe('1KB')
    expect(formatBytes(1229)).toBe('1.2KB')
    expect(formatBytes(12288)).toBe('12KB')
  })
})

describe('serializeEdgeValue', () => {
  it('collapses str payloads to a single line', () => {
    expect(serializeEdgeValue('  alpha\n\nbeta  ', 'str')).toBe('alpha beta')
  })

  it('keeps text payloads verbatim', () => {
    expect(serializeEdgeValue('alpha\n\nbeta', 'text')).toBe('alpha\n\nbeta')
  })

  it('labels markdown and json payloads', () => {
    expect(serializeEdgeValue('# title', 'md')).toBe('The following content is markdown.\n\n# title')
    expect(serializeEdgeValue({ a: 1 }, 'json')).toBe('The following content is application/json.\n\n{\n  "a": 1\n}')
  })

  it('serializes a non-string value for the plain formats', () => {
    expect(serializeEdgeValue({ a: 1 }, 'str')).toBe('{"a":1}')
    expect(serializeEdgeValue(7, 'text')).toBe('7')
  })
})

describe('renderEdgeEnvelope', () => {
  it('renders the header, body, and closing tag the log and the model share', () => {
    const envelope = renderEdgeEnvelope({ from: 'research', to: 'writer', format: 'text', value: 'abc' })
    expect(envelope.text).toBe('[edge research -> writer | format=text | 3B]\nabc\n[/edge]')
    expect(envelope.bytes).toBe(3)
    expect(envelope.truncated).toBe(false)
  })

  it('counts bytes, not characters', () => {
    const envelope = renderEdgeEnvelope({ from: 'a', to: 'b', format: 'text', value: '中文' })
    expect(envelope.bytes).toBe(6)
    expect(envelope.text).toContain('| 6B]')
  })

  it('leaves a payload under the budget intact', () => {
    const envelope = renderEdgeEnvelope({ from: 'a', to: 'b', format: 'text', value: 'abc' }, 8)
    expect(envelope.truncated).toBe(false)
    expect(envelope.text).toBe('[edge a -> b | format=text | 3B]\nabc\n[/edge]')
  })

  it('marks a truncated payload and never splits a code point', () => {
    const envelope = renderEdgeEnvelope({ from: 'a', to: 'b', format: 'text', value: '中文文本' }, 7)
    expect(envelope.bytes).toBe(12)
    expect(envelope.truncated).toBe(true)
    expect(envelope.text).toContain('中文')
    expect(envelope.text).not.toContain('文本')
    expect(envelope.text).toContain(TRUNCATION_MARKER)
    expect(envelope.text).toContain('kept 6 of 12 bytes]')
  })
})
