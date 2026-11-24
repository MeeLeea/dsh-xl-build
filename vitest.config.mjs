import { dirname, join } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit/integration specs live in test/*.spec.ts (and .tsx for JSX assertions)
// and import src/ directly. Snapshots are plugin-local under test/snapshots/.
export default defineConfig({
  test: {
    include: ['test/**/*.spec.{ts,tsx}'],
    environment: 'node',
    testTimeout: 30000,
    resolveSnapshotPath: (testPath, ext) => {
      const name = testPath.replace(/.*[/\\](.+)\.(spec|test)\.[cm]?[jt]sx?$/, '$1')
      return join(dirname(testPath), 'snapshots', name + ext)
    },
  },
})
