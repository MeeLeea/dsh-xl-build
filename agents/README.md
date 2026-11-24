# 智能体定义目录

一个 `*.yml` / `*.yaml` / `*.json` 文件定义一个子智能体。插件启动时同步扫描一次，运行期间监视目录并以 150 ms 防抖热重载，保存即生效。

本目录随包分发，装的是**内置定义**：`memory-curator.yml`（workflow 长期记忆整理）、`manager.yml`（拆解目标并派发给 worker/reviewer）、`worker.yml`（单任务实现）、`reviewer.yml`（只读评审）、`scripting-engineer.yml`（自动化脚本）。自定义 agent 请写到**用户目录**：`<dsh 启动目录>/agents`，不要直接改包内目录。

## 创建流程

1. 确认用户目录：默认为 `dsh` 进程工作目录下的 `agents/`（`agentsDir` 配置项解析自 `process.cwd()`，不是本包目录）。目录不存在会自动创建。
2. 在该目录**第一层**新建文件 `<任意名>.yml`。只扫描本层，不递归子目录；文件名与 `id` 无关，仅用于报错定位，推荐写成 `<id>.yml`。
3. 填四个必填字段：`id`、`name`、`description`、`prompt`。
4. 按需补可选字段（见下表）。默认值即下表的「默认」，省略不写就是默认行为。
5. 保存后在会话里调 `xl_agent_list` 确认，或直接 `@<id> 任务` 使用。若结果里出现在 `invalid` 列表，按 `error` 修正对应文件，其余定义不受影响。

最小可用定义：

```yaml
id: reviewer
name: Reviewer
description: Reviews a diff for correctness.
prompt: You review diffs and report concrete defects.
```

## 字段列表

| 字段 | 类型 | 必填 / 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 必填 | 稳定标识，同时是 `xl_agent_run` 的 `agent` 参数、`@` 提及目标、workflow `agent` 节点的引用值。正则 `^[a-z][a-z0-9-]{1,40}$`：小写字母开头，之后只能是小写字母、数字、连字符，总长 2–41。同一目录内不可重复。 |
| `name` | string | 必填 | 显示名，出现在 `@` 候选菜单和工具列表里。`@` 提及按 `id` 或 `name` 解析；多个 agent 同名时按 `name` 提及会报 `ambiguous-label`。 |
| `description` | string | 必填 | 一行能力摘要，模型通过 `xl_agent_list` 看到的就是它，借此挑选执行者。**不要**把 prompt 内容塞进来。 |
| `prompt` | string | 必填 | 子激活的系统提示词。`readOnly` 生效时实际内容为只读指令 + 空行 + 本字段。 |
| `provider` | string | 默认 `spawn` | subagent 后端注册名，必须是当前 profile 里已注册的后端（标准装配为 `spawn` / `fork`）。 |
| `agentPreset` | string | 默认无 | 授予子智能体工具集与人格的 preset id，只有声明了该启动能力的后端（进程内 `spawn`/`fork`）接受。web profile 可用 `standard`（默认）、`minimal`、`ptc`、`cordis`。注意 `read-only` 是权限 preset 而非 agent preset，填在这里无效。 |
| `model` | string | 默认无 | 子智能体使用的模型 id；省略则用子循环的默认模型。 |
| `reasoningEffort` | `low` \| `medium` \| `high` | 默认无 | 转发给子模型选择的推理强度。 |
| `maxTokens` | 正整数 | 默认无 | 输出 token 上限。 |
| `cwd` | string | 默认无 | 子激活的工作目录。`xl_agent_run` 调用时传的 `cwd` 优先级更高；两者都无则用父会话目录。 |
| `readOnly` | boolean | 默认 `true` | 为 `true` 时给子任务前缀一句只读指令（原文 `Read-only mode: report findings and do not modify files, and do not run commands that change state.`）。**要让 agent 能写文件或执行改状态命令，必须显式写 `readOnly: false`。** |
| `timeoutMs` | 正整数 | 默认 `600000` | 单次激活的墙钟预算，由插件自己计时，到点 dispose 该激活，其结果按 aborted 结算；不依赖后端超时。 |
| `outputSchema` | object（JSON Schema） | 默认无 | 子结果必须满足的结构。启动前先做一次可读的 schema 自检，后端启动时再校验一次。仅支持该能力的后端可用。 |

字段之外：schema 是普通 `z.object`，**未知字段会被静默丢弃而不报错**。所以写 `tools:`、`skills:` 不会生效也不会提示——工具与人格的裁剪一律走 `agentPreset`，因为宿主委派请求没有工具过滤通道。

需要只读分析又想有完整工具集时，用 `agentPreset: standard` + 默认的 `readOnly: true`；需要动手改仓库时写 `readOnly: false`：

```yaml
id: fixer
name: Fixer
description: Applies a concrete fix to the working tree and reports what changed.
prompt: You fix the reported defect with the smallest change and report the files touched.
agentPreset: standard
readOnly: false
timeoutMs: 900000
```

## 校验规则与错误

- **单文件失败隔离**：解析失败或字段校验失败，只把该文件标为 `invalid` 并保留 `${文件名}: ${错误}`，其它定义照常可用；`xl_agent_list` 的 `invalid` 字段会列出它们。
- **重复 id**：同一目录里后读到的文件被判 `invalid`（错误信息指明先在哪个文件定义）。
- **用户覆盖内置**：用户目录中与内置定义同 `id` 的项会覆盖内置项；其余内置项保留。
- **内置文件更严格**：包内 `agents/` 的文件若损坏会让插件加载直接失败，因为那是打包错误而不是用户数据。
- **内置目录不热重载**：包内定义只在插件加载时读取一次（用户目录才被监视），改完需重启 `dsh` 才生效。
- **热重载粒度**：已开始的运行保留它启动时捕获的 `AgentSpec`，改文件只影响之后启动的激活。

## 定义之后如何被使用

- **模型自决**：模型调 `xl_agent_list` 拿到 `id`/`name`/`description`（从不返回 `prompt`），再调 `xl_agent_run { agent, task, cwd? }`。调用立即返回 `childId`，结果由宿主回到本会话。所有激活（工具、`@`、workflow 节点、记忆整理）共用同一个准入闸门，上限 `maxConcurrentAgentTools`（默认 4），超出的按 FIFO 排队；调用方中止且仍在队列中时直接丢弃。
- **用户点名**：输入框写 `@<id>` 或 `@<name>`（写成 `<xl-agent id="..." />` 也认），本步会记录解析结果并注入一条指令，要求第一步就调 `xl_agent_run` 执行该任务。
- **workflow 节点**：`{ "kind": "agent", "agent": "<id>", "task": "..." }` 按 `id` 引用，与工具、`@` 走同一条执行路径。`/workflow validate` 只校验图结构，不检查 agent 是否存在；未知 id 在 run 时才失败，报 `unknown agent "<id>"`。
- **长期记忆**：`memoryCurator` 配置项（默认指向内置 `memory-curator`）按 id 解析；覆盖它就能换掉记忆整理的执行者。

## 改目录位置

用户在 profile 的 `cordis.yml` 里覆盖插件配置（入口 id 见 `cordis.patch.yml`）：

```yaml
- id: xl-build
  config:
    agentsDir: D:\work\my-agents
```

`agentsDir` 支持绝对路径；相对路径仍按 `dsh` 进程工作目录解析。
