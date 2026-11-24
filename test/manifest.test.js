// Scaffold contract: the package manifest, bundle patch, and locale files agree
// on the plugin identity the Cordis loader and the Web client discover.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Read and parse one JSON file from the package root. */
function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'))
}

test('package manifest declares the host and client entry points', () => {
  const manifest = readJson('package.json')
  assert.equal(manifest.name, 'dsh-xl-build')
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.main, './lib/index.js')
  assert.equal(manifest.exports['.'].default, './lib/index.js')
  assert.equal(manifest.exports['./client'].default, './lib/client.js')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(manifest.dsh.client.platform, 'web')
})

test('bundle patch inserts the host row under the package name', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^- insert:/m)
  assert.match(patch, /^\s+- id: xl-build$/m)
  assert.match(patch, /^\s+name: 'dsh-xl-build'$/m)
})

test('locale files carry plugin metadata', () => {
  for (const locale of ['en', 'zh']) {
    const dictionary = readJson(`locale/${locale}.json`)
    assert.equal(typeof dictionary.meta.title, 'string')
    assert.ok(dictionary.meta.title.length > 0)
    assert.equal(typeof dictionary.meta.description, 'string')
    assert.ok(dictionary.meta.description.length > 0)
  }
})
