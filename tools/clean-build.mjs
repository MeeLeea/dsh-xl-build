// Remove every pipeline output so a build starts clean: tsc faces
// (lib/types), the host bundle, and the client bundle (+map).
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const paths = [
  'lib/types',
  'lib/index.js',
  'lib/client.js',
  'lib/client.js.map',
]
for (const entry of paths) {
  rmSync(join(root, entry), { recursive: true, force: true })
}
console.log('clean: removed', paths.length, 'build outputs')
