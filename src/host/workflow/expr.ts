/**
 * JSONLogic-subset expression evaluation for workflow conditions.
 *
 * `router` branches, `loop.until`, and edge conditions all evaluate through
 * this one entry point, so the three call sites cannot drift apart.
 *
 * The subset is closed: `==`, `!=`, `>`, `<`, `and`, `or`, `!`, `in`, `var`.
 * One operator table drives both static validation and runtime evaluation, and
 * nothing here constructs or interprets code at runtime, so a model-generated
 * condition is validated before it can run.
 *
 * This is a deliberate exception to the "prefer maintained dependencies" rule:
 * the available JSONLogic libraries ship no types, so importing one would leak
 * `any` into a strict build. The subset is small and closed, and this file's
 * operator table is the single extension point.
 */

/** Frame values an expression may read. */
export interface ExprFrame {
  /** Run inputs by name. */
  readonly input: Record<string, unknown>
  /** Completed node results by node id. */
  readonly nodes: Record<string, unknown>
  /** Edge payloads by edge id. */
  readonly edges: Record<string, unknown>
}

/** Operators the evaluator accepts, with their operand arity. */
const OPERATORS: ReadonlyMap<string, number> = new Map([
  ['var', 1],
  ['!', 1],
  ['==', 2],
  ['!=', 2],
  ['>', 2],
  ['<', 2],
  ['in', 2],
  ['and', 2],
  ['or', 2],
])

/** An expression is a variable reference, an operator call, or a literal. */
export type Expr = null | boolean | number | string | Expr[] | { [operator: string]: Expr | Expr[] }

/** Read a dotted path from the frame; `undefined` when any segment is missing. */
function readVar(frame: ExprFrame, path: string): unknown {
  const [root, ...rest] = path.split('.')
  const rootValue: unknown = root === 'input' || root === 'nodes' || root === 'edges' ? frame[root] : undefined
  let current: unknown = rootValue
  for (const segment of rest) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Evaluate one operand position (`and`/`or` accept a non-array list too). */
function operandsOf(value: Expr | Expr[]): Expr[] {
  return Array.isArray(value) ? value : [value]
}

/**
 * Validate one expression tree against the closed operator table.
 * @param expr - the untrusted expression.
 * @returns one message per violation; an empty list means it may be evaluated.
 */
export function validateExpr(expr: unknown): string[] {
  if (typeof expr === 'string') {
    return expr === '' ? ['empty string is not a valid expression'] : []
  }
  if (expr === null || typeof expr === 'boolean' || typeof expr === 'number') return []
  if (Array.isArray(expr)) {
    return expr.flatMap((item) => validateExpr(item))
  }
  if (typeof expr === 'object') {
    const entries = Object.entries(expr as Record<string, unknown>)
    if (entries.length !== 1) return ['an operator object must have exactly one key']
    const [operator, operand] = entries[0] ?? []
    if (operator === undefined) return ['an operator object must have exactly one key']
    const arity = OPERATORS.get(operator)
    if (arity === undefined) return [`unknown operator "${operator}"`]
    const operands = operandsOf(operand as Expr)
    if (operands.length !== arity) {
      return [`operator "${operator}" expects ${arity} operand(s), received ${operands.length}`]
    }
    if (operator === 'var' && typeof operands[0] !== 'string') {
      return ['var expects a string path']
    }
    return operands.flatMap((item) => validateExpr(item))
  }
  return [`unsupported expression value ${String(expr)}`]
}

/**
 * Narrow one parsed value to an evaluable expression.
 * @param value - the untrusted value.
 * @returns whether {@link validateExpr} accepts it.
 */
export function isExpr(value: unknown): value is Expr {
  return validateExpr(value).length === 0
}

/** Runtime truthiness for `and`, `or`, and `!`. */
function truthy(value: unknown): boolean {
  return value !== false && value !== null && value !== undefined && value !== '' && value !== 0
}

/** Compare two values for `==`/`!=` without coercing unrelated types. */
function equals(left: unknown, right: unknown): boolean {
  if (typeof left === 'number' && typeof right === 'number') return left === right
  if (typeof left === 'string' && typeof right === 'string') return left === right
  if (typeof left === 'boolean' && typeof right === 'boolean') return left === right
  return left === right
}

/**
 * Evaluate one expression against a frame.
 * @param expr - a validated expression.
 * @param frame - the run inputs, node results, and edge payloads in scope.
 * @returns the expression value; comparisons and logic yield booleans.
 * @throws {Error} when the expression uses an operator outside the closed subset.
 */
export function evalExpr(expr: Expr, frame: ExprFrame): unknown {
  if (expr === null || typeof expr === 'boolean' || typeof expr === 'number' || typeof expr === 'string') {
    return expr
  }
  if (Array.isArray(expr)) return expr.map((item) => evalExpr(item, frame))
  const entries = Object.entries(expr)
  if (entries.length !== 1) throw new Error('an operator object must have exactly one key')
  const [operator, operand] = entries[0] ?? []
  if (operator === undefined) throw new Error('an operator object must have exactly one key')
  const arity = OPERATORS.get(operator)
  if (arity === undefined) throw new Error(`unknown operator "${operator}"`)
  const operands = operandsOf(operand as Expr)
  if (operands.length !== arity) {
    throw new Error(`operator "${operator}" expects ${arity} operand(s), received ${operands.length}`)
  }
  const [first, second] = operands
  switch (operator) {
    case 'var':
      return readVar(frame, String(first))
    case '!':
      return !truthy(evalExpr(first as Expr, frame))
    case '==':
      return equals(evalExpr(first as Expr, frame), evalExpr(second as Expr, frame))
    case '!=':
      return !equals(evalExpr(first as Expr, frame), evalExpr(second as Expr, frame))
    case '>':
    case '<': {
      const left = evalExpr(first as Expr, frame)
      const right = evalExpr(second as Expr, frame)
      if (typeof left !== 'number' || typeof right !== 'number') return false
      return operator === '>' ? left > right : left < right
    }
    case 'in': {
      const needle = evalExpr(first as Expr, frame)
      const haystack = evalExpr(second as Expr, frame)
      if (typeof haystack === 'string') return typeof needle === 'string' && haystack.includes(needle)
      if (Array.isArray(haystack)) return haystack.some((item) => equals(item, needle))
      return false
    }
    case 'and':
      return truthy(evalExpr(first as Expr, frame)) && truthy(evalExpr(second as Expr, frame))
    case 'or':
      return truthy(evalExpr(first as Expr, frame)) || truthy(evalExpr(second as Expr, frame))
    default:
      throw new Error(`unknown operator "${operator}"`)
  }
}

/**
 * Evaluate one condition expression to a boolean.
 * @param expr - a validated expression.
 * @param frame - the values in scope.
 * @returns whether the condition holds; a non-boolean value is not a match.
 */
export function evalCondition(expr: Expr, frame: ExprFrame): boolean {
  return evalExpr(expr, frame) === true
}
