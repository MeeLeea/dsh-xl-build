/**
 * Artifact registration (`plan.md` §7.3): every reference carries a
 * host-generated `dsh-resource://` address, relative paths resolve against
 * the run's working directory, and paths outside it stay absolute inside
 * the same session-scoped address.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { artifactRef, runDir } from '../src/host/paths.ts'

const SESSION = 'sess-1'
const CWD = 'D:/work/demo'

describe('runDir', () => {
  it('joins the runs directory with the run id', () => {
    expect(runDir('D:/work/demo/.dsh/xl-build/runs', 'r-1'))
      .toBe(join('D:/work/demo/.dsh/xl-build/runs', 'r-1'))
  })
})

describe('artifactRef', () => {
  it('addresses a path inside the run working directory relatively', () => {
    const ref = artifactRef({
      nodeId: 'done',
      sessionId: SESSION,
      cwd: CWD,
      absPath: CWD + '/.dsh/xl-build/runs/r-1/artifacts/done/output.md',
      displayPath: 'artifacts/done/output.md',
    })
    expect(ref.path).toBe('dsh-resource://file/session/sess-1/.dsh/xl-build/runs/r-1/artifacts/done/output.md')
  })

  it('normalizes Windows separators before addressing', () => {
    const ref = artifactRef({
      nodeId: 'done',
      sessionId: SESSION,
      cwd: 'D:\\work\\demo',
      absPath: 'D:\\work\\demo\\.dsh\\runs\\r-1\\out.md',
      displayPath: 'artifacts/done/output.md',
    })
    expect(ref.path).toBe('dsh-resource://file/session/sess-1/.dsh/runs/r-1/out.md')
  })

  it('keeps an out-of-workspace absolute path inside the session address', () => {
    const ref = artifactRef({
      nodeId: 'done',
      sessionId: SESSION,
      cwd: CWD,
      absPath: 'D:/elsewhere/report.md',
      displayPath: 'artifacts/done/output.md',
    })
    expect(ref.path).toBe('dsh-resource://file/session/sess-1/D:/elsewhere/report.md')
  })

  it('addresses a relative path as-is when no working directory is known', () => {
    const ref = artifactRef({
      nodeId: 'done',
      sessionId: SESSION,
      cwd: undefined,
      absPath: 'artifacts/done/output.md',
      displayPath: 'artifacts/done/output.md',
    })
    expect(ref.path).toBe('dsh-resource://file/session/sess-1/artifacts/done/output.md')
  })

  it('maps the producing node, the stable id, and the display title', () => {
    const ref = artifactRef({
      nodeId: 'done',
      sessionId: SESSION,
      cwd: CWD,
      absPath: CWD + '/.dsh/runs/r-1/artifacts/done/output.md',
      displayPath: 'artifacts/done/output.md',
      bytes: 42,
    })
    expect(ref.nodeId).toBe('done')
    expect(ref.id).toBe('artifacts/done/output.md')
    expect(ref.kind).toBe('file')
    expect(ref.title).toBe('output.md')
    expect(ref.bytes).toBe(42)
  })

  it('omits the byte size when unknown', () => {
    const ref = artifactRef({
      nodeId: 'done',
      sessionId: SESSION,
      cwd: CWD,
      absPath: CWD + '/out.md',
      displayPath: 'artifacts/done/output.md',
    })
    expect('bytes' in ref).toBe(false)
  })
})