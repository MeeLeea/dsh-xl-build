# 请求模板：agent 节点发给 LLM 的 request

`xl-build-pipeline` 的四个 agent 节点（`plan` / `implement` / `automate` / `review`）在模板渲染完成后，实际送到模型的是 `system` + `messages` + `tools` 三段。本文给出骨架、逐节点实例、每个占位符的来源，以及核对方法。两条委派路径的差异见 [delegation-paths.md](delegation-paths.md)，工作流字段语义见 [../workflow/README.md](../workflow/README.md)。

## 1 组装顺序

```
workflow/xl-build-pipeline.json  node.task
  └─ renderTemplate()           {{input.goal}} / {{nodes.plan}} 等替换为真实文本
  └─ composeNodeInput()         context 默认 'none' → 不附加入边载荷
  └─ runner.start({ spec, task, delivery: 'caller' })
       └─ buildPromptBlocks()   首块 = 只读声明 + 角色提示词，次块 = task
       └─ subagent startLocal() 两个 block 包成同一条 user 消息
```

三条结论先写明：

- **YAML `prompt` 与 workflow `task` 都是 user 消息内容**，前者是首块，后者是次块，不会拼成一条字符串。
- **system prompt 与这两者无关**。四个定义都写了 `agentPreset: standard`，子会话挂的是 `packages/bundle/web-app/presets/standard.patch.yml` 装配出的系统提示。
- **`readOnly: true` 只加一句前缀**，工具集不变；真正裁剪工具的是 `xl-<id>` preset 路径（`agents/README.md` 映射表），workflow 节点不走那条路。

## 2 通用骨架

序列化前的逻辑结构（provider serializer 负责最终编码，`packages/llm/llm-deepseek/src/serialize.ts`）：

```jsonc
{
  "system": "<standard preset 装配结果>",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "<只读声明？> + <agents/*.yml 的 prompt>" },
        { "type": "text", "text": "<renderTemplate(node.task) + 入边载荷？>" }
      ]
    },
    { "role": "user", "content": "Current runtime context. This snapshot supersedes earlier runtime-context snapshots. ..." }
  ],
  "tools": [ /* standard preset 挂载的工具 */ ],
  "max_tokens": "<子激活模型配置>",
  "thinking": "<模型与 reasoningEffort 决定>"
}
```

| 段 | 来源 |
| --- | --- |
| `system` | `spec.agentPreset` = `standard`：persona 前缀（`You are a coding agent powered by the {{model}} model.`）+ `dsh-agent-instructions`（注入工作目录 AGENTS.md，`maxBytes: 65536`）+ 时间上下文等 section。不含 YAML `prompt`。 |
| `messages[0].content[0]` | `buildPromptBlocks`：`readOnly === true` 时前缀 `Read-only mode: report findings and do not modify files, and do not run commands that change state.`，后接 `\n\n`，再接 `spec.prompt`。 |
| `messages[0].content[1]` | `agentOwnText`：`renderTemplate(node.task, frame)`；`context.from: 'memory'` 时前置 `[workflow memory]` 段，`context.from: 'run-input'` 时末尾追加 `Run inputs: <JSON>`。 |
| `messages[1]` | `systemPrompt.context()` 的贡献（subagent 身份声明等运行时信息），由 agent-loop 作为 `source.kind = 'runtime-context'` 的独立 user 消息投递，位置由 admission 决定。 |
| `tools` | `standard` preset 挂载的工具：`bash`/`pwsh`（按 `process.platform` 各禁一个）、`fs`、`fs-search`、`jobs`、`schedule`、`skill`、`goal`、`plan-mode` 等。`readOnly` 不减少任何一项。 |
| `max_tokens` | 这 4 个 YAML 未设 `maxTokens`，取子激活模型配置的默认值。 |
| `thinking` | 未设 `reasoningEffort`，取子循环默认。 |

`delivery: 'caller'` 还意味着不追加 `send_message` 返回指引、不向父会话回投——节点结果只从 `result.output` 取。

## 3 节点实例

下面只写 `messages[0].content` 的两个 block；`system` 与 `tools` 四节点相同。

### 3.1 plan — `manager`，`readOnly: true`

```text
block 1:
Read-only mode: report findings and do not modify files, and do not run commands that change state.

You coordinate work instead of doing it yourself.

- Restate the goal as concrete acceptance criteria before splitting it.
- Split it into the fewest independent subtasks; for each, name the files it owns and the scope it must not exceed.
- Delegate with xl_agent_list / xl_agent_run: `worker` for implementation, `reviewer` for verification. Run independent subtasks in parallel.
- Merge the returned reports, and re-delegate a narrowed task when results conflict or a subtask failed.
- Report the subtask list with owner, outcome, and the verification evidence each child returned. Never claim work no child reported.
- Escalate to the caller with the specific blocker when a subtask is ambiguous, out of scope, or blocked by a missing decision.

block 2:
这是 workflow 引擎的一次节点调用：只产出执行计划，不要调用 xl_agent_run 派发子任务，也不要修改任何文件。
目标：<run 输入 goal>
输出一份有序子任务清单：每项写明负责角色（worker / scripting-engineer）、目标文件、范围边界、验收方式，并标出哪些项可以并行。
```

### 3.2 implement — `worker`，`readOnly: false`

```text
block 1:
You implement exactly one assigned subtask with the smallest correct change.

- Read the relevant code first and follow the conventions already present in the files you touch.
- Stay inside the assigned scope. If the task cannot be done correctly within it, stop and report what larger change is required instead of making it.
- Do not suppress type or lint errors; fix the cause.
- Run the focused check that proves the change (test, typecheck, or build target) and paste its actual result.
- Report: what changed, which files, the command you ran, the result, and anything left undone. Never claim verification you did not run.

block 2:
完成计划中指派给 worker 的全部子任务：保持最小正确变更，跑一个聚焦检查证明结果，报告改动文件与实际检查输出。
计划：
<plan 节点的输出文本>
```

### 3.3 automate — `scripting-engineer`，`readOnly: false`

```text
block 1:
You write small, robust automation scripts.

- Use a runtime the target repository already relies on; do not introduce a new language or dependency for a one-off task.
- Make the script non-interactive and fail fast: checked exit codes, strict shell flags, no silent fallbacks.
- Take paths and options as arguments instead of hardcoding them, and print actionable errors for missing input, missing tools, and partial output.
- Run the script end to end on a realistic input before reporting, and paste the actual output.
- Report: the script path, how to invoke it, what it verified, and any precondition the caller must satisfy.

block 2:
为计划中适合自动化的部分写一个非交互脚本并实际运行验证：不引入新依赖，报告脚本路径、调用方式与实际输出。
计划：
<plan 节点的输出文本>
```

### 3.4 review — `reviewer`，`readOnly: true`

```text
block 1:
Read-only mode: report findings and do not modify files, and do not run commands that change state.

You review code and never modify it.

- Read the diff, then the surrounding code it depends on, before judging it.
- Report findings ordered by severity. Each finding states file:line, the defect, why it is wrong, and a concrete fix.
- Cover correctness, error and edge-case handling, resource and lifecycle cleanup, and consistency with existing patterns and the declared task.
- State plainly when the change has no defects; do not invent nitpicks to fill the report.
- Do not restate the diff, and do not approve code you could not inspect.

block 2:
只读复核以下两路产物对应的仓库变更：正确性、边界与资源清理、与计划的一致性。按严重度列出缺陷（file:line + 具体修复）；没有缺陷就明确说明，不要编造 nitpick。
计划：
<plan 输出>
实现报告：
<implement 输出>
自动化脚本报告：
<automate 输出>
```

`merge`（join）的文本不在 review 的 request 里：任务模板没有 `{{nodes.merge}}`，合并结果只沿 `merge -> review` 的边传递，而 `context` 为默认 `'none'`，边载荷不会并入任务。

## 4 占位符来源

| 模板引用 | 求值来源 | 备注 |
| --- | --- | --- |
| `{{input.goal}}` | run 输入 | 必填参数缺失时 run 在启动阶段失败 |
| `{{nodes.<id>}}` | 节点输出的**原文** | 不受边 `maxBytes` 截断；对象值经 `JSON.stringify` 内插，不是 `[object Object]` |
| `{{edges.<id>}}` | 边载荷 | 可能已被 `maxBytes` 截断并标记 `[truncated: ...]` |
| `{{memory}}` | 长期记忆全文 | 关闭或不存在时为空串 |

`context` 默认 `'none'`：入边载荷完全不进任务。写 `context: 'all'` 或 `{ "lastMessages": n }` 才会把 `[edge a -> b | format=... ]` 段落并入 block 2，并受 `edgeMaxBytes`（默认 64000）约束。

## 5 与 preset 路径的差别

| 维度 | workflow / `xl_agent_run` 路径（本文） | `xl-<id>` preset 路径 |
| --- | --- | --- |
| YAML `prompt` | user 消息首块 | persona `complete: true`，完整 system prompt |
| `readOnly` | 提示词前缀（软约束） | 工具行裁剪（硬约束，不挂 shell） |
| `model` / `cwd` / `outputSchema` | 生效 | 不携带 |

四个定义写的是 `agentPreset: standard`，所以走左列。把它们改成 `agentPreset: xl-<id>` 不会让 workflow 节点变严格，只会让 `xl_subagent` 那条路生效。

## 6 核对方法

- **journal**：`<runsDir>/<runId>/journal.jsonl` 的 `node-input` 记录含 `text`（渲染后的任务）与 `edges`（边载荷）。这是渲染结果，不含角色块与只读前缀。
- **子会话记录**：子会话首条 user 消息的两个 text block 就是最终投递内容；`readOnly` 前缀出现在首块开头。
- **工具**：`xl_agent_list` 只返回 `id` / `name` / `description`，从不返回 `prompt`；想确认 prompt 是否投递，看子会话记录而不是工具输出。
- **system**：用 `/workflow run` 后查看子会话的 system prompt 快照，或直接读 `standard.patch.yml`；YAML 里搜不到自己的 prompt 是正常现象。

## 7 常见误区

1. **以为 `prompt` 进了 system prompt。** 只有 preset 路径如此；workflow 路径下它在 user 消息里，优先级低于 system。
2. **以为 `readOnly: true` 会禁用写工具。** 它只是一句话；`standard` preset 仍挂 `write` / `edit` / `bash`。
3. **以为 `{{nodes.plan}}` 会被边预算截断。** 模板取节点输出原文；截断只发生在边载荷，也就是 `context` 并入的那部分。
4. **以为 `merge` 的输出会出现在 review 里。** review 只引用 `plan` / `implement` / `automate`。
5. **忽略角色提示词与 task 的指令冲突。** `manager` 的 prompt 要求「用 `xl_agent_list` / `xl_agent_run` 派发」，`plan` 的 task 要求「不要调用 `xl_agent_run` 派发子任务」。两者同处一条 user 消息，靠后且更具体的 task 才是本次约束；改 task 时要一并检查 prompt 是否还在鼓励相反行为。
