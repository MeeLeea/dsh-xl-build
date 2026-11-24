/**
 * Template evaluation for node inputs and outputs: `{{input.x}}`,
 * `{{nodes.id.output}}`, `{{edges.id}}`, and `{{memory}}`.
 *
 * Evaluation is string substitution plus a dotted lookup — never expression
 * evaluation — so a template can neither execute code nor reach outside the
 * frame it was handed. A reference that resolves to nothing renders as an
 * empty string; `validateWorkflow`'s V13 rejects unknown references before a
 * run starts, so an empty render at runtime means an absent value, not a
 * silent typo.
 */
import type { ExprFrame } from './expr.ts'

/** Values a template may read; the expression frame plus workflow memory. */
export interface TemplateFrame extends ExprFrame {
  /** Distilled workflow memory; the empty string when memory is off or absent. */
  readonly memory: string
}

/** One `{{reference}}` occurrence. */
export const TEMPLATE_PATTERN: RegExp = /\{\{\s*([^}]+?)\s*\}\}/g

/**
 * Extract the reference names from one template string.
 * @param text - the template.
 * @returns reference names in appearance order.
 */
export function templateRefs(text: string): string[] {
  return [...text.matchAll(TEMPLATE_PATTERN)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
}

/** Read a dotted path from the frame; `undefined` when a segment is missing. */
function readPath(frame: TemplateFrame, path: string): unknown {
  const [root, ...rest] = path.split('.')
  let current: unknown = root === 'input' || root === 'nodes' || root === 'edges' ? frame[root] : undefined
  for (const segment of rest) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Render one resolved value as template text. */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value) ?? ''
}

/**
 * Render one template against the run frame.
 * @param text - the template text.
 * @param frame - the inputs, node results, edge payloads, and memory in scope.
 * @returns the text with every reference substituted.
 */
export function renderTemplate(text: string, frame: TemplateFrame): string {
  return text.replace(TEMPLATE_PATTERN, (_match, reference: string) => {
    if (reference === 'memory') return frame.memory
    return stringify(readPath(frame, reference))
  })
}
