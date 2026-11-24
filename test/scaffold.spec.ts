import { describe, expect, it } from 'vitest'
import { apply, name } from '../src/host/index.ts'

describe('host plugin entry', () => {
  it('exports the loader name', () => {
    expect(name).toBe('dsh-xl-build')
  })

  it('exports the apply function', () => {
    expect(typeof apply).toBe('function')
  })
})
