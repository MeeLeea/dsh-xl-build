# dsh-xl-build

Declarative sub-agent definitions, workflow topology, and a live run board for [DeepSeek Harness](https://www.deepseek.com) — in one standalone third-party package.

The host half (agent registry with hot reload, the workflow engine, the `/workflow` command, the `xl_agent_list`/`xl_agent_run` tools, and the `xlBuild` session projection) mounts as a Cordis plugin; the Web client half (run board panel) is discovered from the `dsh.client` declaration in `package.json`.

## Requirements

- An installed `dsh` with a profile providing `tools`, `commands`, `sessionProjections`, `subagents`, and `agentPresets` (the standard `web`/desktop profiles do). The `spawn` subagent backend backs both the shared agent runner and the registered-preset delegation tool.
- Optional: Python 3.9+ with no third-party dependencies, only to compile `.py` workflow definitions (the bundled `xl_build` package; the plugin reads the compiled JSON only).
- All runtime dependencies resolve from the host dsh installation; `js-yaml` is inlined into `lib/index.js` at build time.

## Install

```sh
dsh plugin --profile web add <path-to-dsh-xl-build>
```

Or manually in your profile's `package.json`:

```json
{
  "dependencies": {
    "dsh-xl-build": "link:<path-to-dsh-xl-build>"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-xl-build"]
    }
  }
}
```

Then restart `dsh web`.

## Configuration

Every field is overridable from `cordis.yml`; the schema defaults in `src/host/config.ts` are the single source of truth.

| Field | Default | Meaning |
| --- | --- | --- |
| `agentsDir` | `agents` | Directory holding agent definition files (`*.yml`, `*.yaml`, `*.json`), resolved against the process working directory |
| `workflowsDir` | `workflows` | Directory holding workflow definition files |
| `runsDir` | `.dsh/xl-build/runs` | Directory receiving per-run artifacts |
| `maxConcurrentNodes` | `4` | Graph nodes executing at once within one run |
| `maxConcurrentAgentTools` | `4` | Unsettled activations started through `xl_agent_run` |
| `runTimeoutMs` | `1800000` | Wall-clock budget for one run |
| `maxSteps` | `200` | Engine steps allowed per run |
| `scriptTimeoutMs` | `120000` | Wall-clock budget for one script node |
| `allowedScriptRuntimes` | `['shell', 'ptc']` | Runtimes a script node may request |
| `retryableToolErrors` | `[]` | Tool error codes that may be retried; empty means never |
| `wirePreviewBytes` | `2048` | Byte budget for one node preview in the client projection |
| `recentRuns` | `5` | Settled runs kept in the client projection alongside active runs |
| `persistRuns` | `true` | Write completed runs under `runsDir` |
| `memoryEnabled` | `true` | Distil long-term memory after a run settles |
| `memoryDir` | `.dsh/xl-build/memory` | Directory holding distilled workflow memory |
| `memoryMaxBytes` | `16000` | Byte budget for one workflow's memory file |
| `memoryCurator` | `memory-curator` | Agent spec id curating memory |
| `presetIdPrefix` | `xl-` | Namespace prepended to each agent spec id when registering it as a dsh agent preset |
| `runRootProvider` | `spawn` | LLM provider route of the dormant run-root session a `/workflow run` executes in |
| `runRootModel` | — | Optional model id overriding the run-root session default |

## Agent definitions

One file per agent under `agentsDir`; the file body is the agent spec:

```yaml
id: reviewer
name: Reviewer
description: Reviews a diff for correctness.
prompt: You review diffs and report concrete defects.
# provider: spawn          # subagent backend name
# agentPreset: standard    # preset id granting tools/persona (spawn only)
# model: deepseek-chat
# reasoningEffort: high
# maxTokens: 4096
# cwd: /path/to/repo
# readOnly: true           # prefix the child prompt with a read-only instruction
# timeoutMs: 600000
# outputSchema: { type: object }
```

A file that fails validation is reported as `invalid` with its parse error and does not affect the other definitions; the directory is watched (150 ms debounce) so edits take effect without a restart. Definition files own tool/persona trimming through `agentPreset` — the spec has no `tools` or `skills` fields, because the host delegation request has no tool-filter channel. The creation flow, every field with its default, and the validation rules are documented in [agents/README.md](agents/README.md).

Every valid definition (except the `memoryCurator` id) is also registered as a dsh agent preset — id `presetIdPrefix` + spec id, default `xl-reviewer` for `reviewer` — and an `xl_subagent` delegation tool (`provider: spawn`) lists exactly those ids under `agent_preset`, so the model can select a role through the built-in delegation path. The preset composition carries the YAML prompt as the child's complete system prompt and enforces `readOnly` by omitting mutating tools; fields a preset cannot express (`model`, `cwd`, `outputSchema`, `timeoutMs`, a non-`spawn` `provider`) stay on the `xl_agent_run` path and are reported at registration. The mapping table and reload semantics live in [agents/README.md](agents/README.md).

## Workflows

Workflow documents live under `workflowsDir`; the `/workflow` command (`list` / `validate <file>` / `run <id> ["<single input>"] [--input k=v] [--self <nodeId>]` / `export <id> --mermaid`) drives them, and the package's own `workflow/` directory ships as a built-in catalog merged under it — a valid user document with the same id shadows the shipped one, so the bundled example runs without any `workflowsDir` configuration. The engine executes the graph with per-node state, edge payloads, joins, and loops, and settled runs are written under `runsDir` with artifacts, journal, and `dsh-resource://` links in the run board. [workflow/README.md](workflow/README.md) is the field-by-field reference: creation flow, every document/node/edge field with its default, template and condition syntax, the V1–V17 validation table, and which fields the engine does not consume yet. [doc/user-guide.md](doc/user-guide.md) covers installation, the three entry points, the Python DSL (compile with the bundled `py/xl_build` package: `python py/xl_build build <file>.py -o <out>.json`, or `python -m xl_build` with `py/` on `PYTHONPATH`; the plugin reads the compiled JSON only), memory limits of `self` nodes, the long-term memory file (read at run start, distilled by one curation activation after each settled run), and the division of labor with the built-in `workflow` tool.

## Model Experience

`xl_agent_list` returns each agent's `id`, `name`, and `description` (never the prompt) plus any invalid definition files with their errors, so a model can pick an executor without leaking another agent's instructions into its context.

## Known limitations

- **Memory is per workflow.** Long-term memory is one `<workflowId>.md` file, read only by workflow runs and distilled by one curation activation after each settled run; the `xl_agent_run` tool and @-mention paths never read or write memory (`doc/user-guide.md` covers the mechanism and its cost).
- **No resume.** A run interrupted mid-graph does not restart from its journal yet (`plan.md` §6.5 leaves the boundary to a later scope).
- **No PTC export.** The one-way compile of pure-agent topologies to the built-in `workflow` engine (`plan.md` G13) is not provided; the plugin never registers `ctx.workflowEngine`.
- **Live-run acceptance is manual.** `dsh plugin add`, a real `/workflow run`, and board observation need an installed dsh with a model; the mechanical surface (build, unit tests, the Python compile path) runs in `npm run build`.
- `lib/` is build output; a fresh clone must run `npm install` before `npm run build`.

## Building

`src/` is the source of truth; `lib/` is generated.

```sh
npm install    # once
npm run build  # clean -> tsc (host + client) -> tsdown bundles -> node tests -> vitest specs
npm test       # tests only
npm run test:spec -- <name>   # one spec by filename filter
```

Notes:

- `tools/build.mjs` runs tsc and tsdown through their library APIs in one process: the sandboxed session shell denies child spawns, so neither CLI can be shelled out to.
- No Typert generation: this plugin uses no `@Remote`; the client data channel is the projection `wire.view`.

## Layout

```
package.json        # dsh.bundle + dsh.client manifest, exports map
cordis.patch.yml    # composition: insert the host entry (client discovered via dsh.client)
lib/index.js        # host bundle (registry, projection, tool)
lib/client.js       # browser bundle (run board panel)
lib/types/          # tsc emit (host at root, client under client/)
src/host            # TypeScript host sources
src/client          # TypeScript client sources
py/                 # bundled Python DSL package (xl_build); ships in npm files
tools/              # build pipeline: clean-build, build, run-tests
test/               # node:test contracts (*.test.js) + vitest specs (*.spec.ts)
doc/plan.md         # design authority
doc/impl-plan.md    # construction plan (task order and acceptance)
doc/user-guide.md   # usage guide: install, entry points, artifacts, Config table
```
