import { describe, expect, it } from 'vitest'
import { Config } from '../src/host/config.ts'

describe('Config', () => {
  it('fills every tunable with its documented default', () => {
    expect(Config({})).toEqual({
      agentsDir: 'agents',
      workflowsDir: 'workflows',
      runsDir: '.dsh/xl-build/runs',
      maxConcurrentNodes: 4,
      maxConcurrentAgentTools: 4,
      runTimeoutMs: 1_800_000,
      maxSteps: 200,
      runRootProvider: 'spawn',
      scriptTimeoutMs: 120_000,
      allowedScriptRuntimes: ['shell', 'ptc'],
      retryableToolErrors: [],
      wirePreviewBytes: 2_048,
      recentRuns: 5,
      persistRuns: true,
      memoryEnabled: true,
      memoryDir: '.dsh/xl-build/memory',
      memoryMaxBytes: 16_000,
      memoryCurator: 'memory-curator',
      presetIdPrefix: 'xl-',
    })
  })

  it('lets a cordis.yml override win over the default', () => {
    const config = Config({
      agentsDir: 'my-agents',
      maxSteps: 5,
      allowedScriptRuntimes: ['ptc'],
      memoryEnabled: false,
    })
    expect(config.agentsDir).toBe('my-agents')
    expect(config.maxSteps).toBe(5)
    expect(config.allowedScriptRuntimes).toEqual(['ptc'])
    expect(config.memoryEnabled).toBe(false)
    expect(config.maxConcurrentNodes).toBe(4)
  })

  it('rejects a script runtime outside the allowed union', () => {
    expect(() => Config({ allowedScriptRuntimes: ['bash'] })).toThrow()
  })
})
