import { describe, expect, it } from 'vitest'
import { renderTemplate, templateRefs } from '../src/host/workflow/template.ts'
import type { TemplateFrame } from '../src/host/workflow/template.ts'

const FRAME: TemplateFrame = {
  input: { version: '1.2.3', count: 3, flag: true },
  nodes: { work: { output: 'finished', payload: { a: 1 } } },
  edges: { e1: 'edge text' },
  memory: 'previous run distilled this.',
}

describe('templateRefs', () => {
  it('lists references in appearance order and tolerates inner spaces', () => {
    expect(templateRefs('use {{ input.version }} and {{nodes.work.output}}')).toEqual(['input.version', 'nodes.work.output'])
    expect(templateRefs('no references here')).toEqual([])
  })
})

describe('renderTemplate', () => {
  it('substitutes inputs, node outputs, edge payloads, and memory', () => {
    expect(renderTemplate('v{{input.version}} => {{nodes.work.output}}', FRAME)).toBe('v1.2.3 => finished')
    expect(renderTemplate('edge: {{edges.e1}}', FRAME)).toBe('edge: edge text')
    expect(renderTemplate('memory: {{memory}}', FRAME)).toBe('memory: previous run distilled this.')
  })

  it('renders primitives and JSON-serializes structured values', () => {
    expect(renderTemplate('{{input.count}} {{input.flag}}', FRAME)).toBe('3 true')
    expect(renderTemplate('{{nodes.work.payload}}', FRAME)).toBe('{"a":1}')
  })

  it('renders an unresolved reference as an empty string', () => {
    expect(renderTemplate('a{{input.missing}}b', FRAME)).toBe('ab')
    expect(renderTemplate('a{{nodes.absent.output}}b', FRAME)).toBe('ab')
    expect(renderTemplate('{{memory}}', { ...FRAME, memory: '' })).toBe('')
  })

  it('keeps text without references unchanged and renders several references', () => {
    expect(renderTemplate('plain text', FRAME)).toBe('plain text')
    expect(renderTemplate('{{input.version}}-{{input.count}}-{{nodes.work.output}}', FRAME)).toBe('1.2.3-3-finished')
  })

  it('never evaluates the substituted text as an expression', () => {
    // A reference that looks like an expression is still just a lookup.
    expect(renderTemplate('{{input.version}}', FRAME)).toBe('1.2.3')
    expect(renderTemplate('&{{nodes.work.output}}', FRAME)).toBe('&finished')
  })
})
