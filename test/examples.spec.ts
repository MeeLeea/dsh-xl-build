/**
 * The user-guide examples are executed, not merely quoted: the JSON workflow
 * parses and validates, the mermaid export equals the guide block, and the
 * agent-spec fixtures carry the fields the registry requires.
 */
import { readFileSync } from 'node:fs'
import { load as loadYaml } from 'js-yaml'
import { expect, test } from 'vitest'
import { parseWorkflowText } from '../src/host/workflow/loaders.ts'
import { toMermaid } from '../src/host/workflow/mermaid.ts'
import { validateWorkflow } from '../src/host/workflow/validate.ts'

const DEMO = 'test/fixtures/release-demo.json'

const GUIDE_MERMAID = [
  "flowchart TD",
  '  start(["input"])',
  '  research["researcher"]',
  '  draft["writer"]',
  '  done[("output")]',
  '  start -->|text| research',
  '  research -->|md| draft',
  '  draft -->|md| done',
].join('\n')

function loadDemo(): ReturnType<typeof parseWorkflowText> {
  return parseWorkflowText(readFileSync(DEMO, 'utf8'), DEMO)
}

test("the user-guide example workflow parses and validates", () => {
  const document = loadDemo()
  expect(document.id).toBe("release-demo")
  expect(document.entry).toBe("start")
  expect(validateWorkflow(document)).toEqual([])
})

test("the user-guide mermaid block matches the export of the example", () => {
  expect(toMermaid(loadDemo())).toBe(`${GUIDE_MERMAID}\n`)
})

test("the user-guide agent fixtures carry the registry-required fields", () => {
  for (const name of ["researcher", "writer"]) {
    const spec = loadYaml(readFileSync(`test/fixtures/agents/${name}.yml`, 'utf8')) as {
      id?: unknown, name?: unknown, description?: unknown, prompt?: unknown,
    }
    expect(typeof spec.id, "id").toBe("string")
    expect(typeof spec.name, "name").toBe("string")
    expect(typeof spec.description, "description").toBe("string")
    expect(typeof spec.prompt, "prompt").toBe("string")
  }
})