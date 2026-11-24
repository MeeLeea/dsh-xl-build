import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evalCondition, evalExpr, validateExpr } from '../src/host/workflow/expr.ts'
import type { ExprFrame } from '../src/host/workflow/expr.ts'

const FRAME: ExprFrame = {
  input: { version: '1.2.3', env: 'prod', count: 3 },
  nodes: { start: { done: true, output: 'ok' } },
  edges: { e1: { ok: true } },
}

describe('validateExpr', () => {
  it('accepts the closed operator subset', () => {
    expect(validateExpr({ and: [{ '>': [{ var: 'input.count' }, 2] }, { in: [{ var: 'input.env' }, ['dev', 'prod']] }] }))
      .toEqual([])
    expect(validateExpr({ '!': [{ var: 'nodes.start.done' }] })).toEqual([])
    expect(validateExpr('literal')).toEqual([])
  })

  it('reports an unknown operator', () => {
    expect(validateExpr({ merge: [1, 2] })).toEqual(['unknown operator "merge"'])
  })

  it('reports a wrong operand count and a non-string var path', () => {
    expect(validateExpr({ '>': [1] })).toEqual(['operator ">" expects 2 operand(s), received 1'])
    expect(validateExpr({ var: 3 })).toEqual(['var expects a string path'])
  })

  it('reports a malformed operator object', () => {
    expect(validateExpr({ and: [true, true], or: [false, false] }))
      .toEqual(['an operator object must have exactly one key'])
    expect(validateExpr('')).toEqual(['empty string is not a valid expression'])
  })
})

describe('evalExpr', () => {
  it('reads dotted paths from every frame root', () => {
    expect(evalExpr({ var: 'input.version' }, FRAME)).toBe('1.2.3')
    expect(evalExpr({ var: 'nodes.start.output' }, FRAME)).toBe('ok')
    expect(evalExpr({ var: 'edges.e1.ok' }, FRAME)).toBe(true)
    expect(evalExpr({ var: 'input.missing' }, FRAME)).toBeUndefined()
    expect(evalExpr({ var: 'nodes.absent.done' }, FRAME)).toBeUndefined()
  })

  it('compares without coercing across types', () => {
    expect(evalExpr({ '==': [1, 1] }, FRAME)).toBe(true)
    expect(evalExpr({ '==': [1, '1'] }, FRAME)).toBe(false)
    expect(evalExpr({ '!=': ['a', 'b'] }, FRAME)).toBe(true)
    expect(evalExpr({ '>': [3, 2] }, FRAME)).toBe(true)
    expect(evalExpr({ '<': [3, 2] }, FRAME)).toBe(false)
  })

  it('treats a non-number comparison as no match', () => {
    expect(evalExpr({ '>': ['3', 2] }, FRAME)).toBe(false)
    expect(evalExpr({ '<': [{ var: 'input.missing' }, 2] }, FRAME)).toBe(false)
  })

  it('supports in over strings and lists', () => {
    expect(evalExpr({ in: ['1.2', { var: 'input.version' }] }, FRAME)).toBe(true)
    expect(evalExpr({ in: [{ var: 'input.env' }, ['dev', 'prod']] }, FRAME)).toBe(true)
    expect(evalExpr({ in: ['stage', ['dev', 'prod']] }, FRAME)).toBe(false)
    expect(evalExpr({ in: ['a', 7] }, FRAME)).toBe(false)
  })

  it('applies logic operators by truthiness', () => {
    expect(evalExpr({ and: [true, { var: 'nodes.start.done' }] }, FRAME)).toBe(true)
    expect(evalExpr({ or: [false, { '==': [{ var: 'input.count' }, 3] }] }, FRAME)).toBe(true)
    expect(evalExpr({ '!': [{ var: 'input.missing' }] }, FRAME)).toBe(true)
  })

  it('evaluates a nested condition through evalCondition', () => {
    const condition = {
      and: [
        { '>': [{ var: 'input.count' }, 2] },
        { in: [{ var: 'input.env' }, ['dev', 'prod']] },
      ],
    }
    expect(evalCondition(condition, FRAME)).toBe(true)
    expect(evalCondition({ '==': [{ var: 'input.env' }, 'dev'] }, FRAME)).toBe(false)
    // A non-boolean result is not a match.
    expect(evalCondition({ var: 'input.version' }, FRAME)).toBe(false)
  })

  it('throws on an expression that skipped validation', () => {
    expect(() => evalExpr({ merge: [1, 2] }, FRAME)).toThrow('unknown operator "merge"')
    expect(() => evalExpr({ '>': [1] }, FRAME)).toThrow('expects 2 operand(s)')
  })
})

describe('expression safety', () => {
  it('never evaluates source text', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/host/workflow/expr.ts', import.meta.url)), 'utf8')
    expect(source).not.toMatch(/\beval\(/)
    expect(source).not.toMatch(/new Function/)
  })
})
