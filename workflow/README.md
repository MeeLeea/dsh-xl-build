# 工作流定义参考

`dsh-xl-build` 的图式编排：拓扑是磁盘上的声明式文档，`/workflow` 命令负责 `list` / `validate` / `run` / `export`，引擎按节点执行，每次 Run 的 journal、产物和长期记忆各自落盘。

**目录名注意**：用户目录 `workflowsDir` 默认 `workflows/`（复数，相对 `dsh` 进程工作目录）。本目录（插件包的 `workflow/`）存放这份参考文档和示例工作流 `xl-build-pipeline`（`.yml` / `.json` / `.py` 三种格式，见「示例工作流的调用命令」），并作为**内置工作流目录**随包加载：`run` / `export` / `list` 先查用户目录、再回落内置目录，用户目录中同 id 的有效文档覆盖内置文档；`.md` 不在扫描范围，所以即使用户把本目录设为 `workflowsDir` 也不会误读本文。

## 创建流程

1. 建目录：`<dsh 启动目录>/workflows/`。扫描器不会替你创建它，目录不存在时 `/workflow list` 只回答 `No workflows are saved.`
2. 写一个文档文件，扩展名 `.json` / `.yml` / `.yaml`，放在该目录第一层。填齐必填项：`schemaVersion`、`id`、`name`、`entry`、`nodes`、`edges`。
3. 校验：`/workflow validate workflows/<file>`。通过时回答 `Valid: <id> (n nodes, m edges)`；失败时逐条列出 `V<n>: <原因>`。
4. 试跑：`/workflow run <id> "<唯一输入>"`（多输入文档改用 `--input k=v`）。命令立刻回答 `started run <runId> for <id>`，Run 在独立根会话里执行，结束时向发起会话发 follow-up。
5. 复核：`/workflow list` 看清单、`/workflow export <id> --mermaid` 核对拓扑，侧栏看板看节点状态与产物。

## 目录与文件约定

- **只扫描第一层**，不递归子目录；一个文件一个文档。
- **只认 `.json` / `.yml` / `.yaml`**。`.py` 不参与目录扫描，必须先用插件自带的 `xl_build` 编译成 JSON 放进目录（见「Python DSL」）。
- **文件和 id 无关**：`run <id>`、`export <id>` 按文档里的 `id` 匹配；`validate <file>` 才按文件路径（相对进程工作目录）。
- **坏文件只坏自己**：解析或校验失败的文件在 `list` 里显示 `invalid — <错误>`，不影响其它文件；但 `run` 只接受校验通过的文档。
- **内置目录与优先级**：包内 `workflow/`（以 `xl-build-pipeline.yml` 为标记）随包加载为内置目录，与用户目录合并：用户目录中同 id 的有效文档覆盖内置文档，内置目录内部同 id 的多个文件按文件名字序取第一个。内置文件损坏是打包错误，插件加载直接失败；加载后才损坏的内置文件会被合并逻辑跳过，重启后重新门控。`list` 输出里内置条目带 `(builtin)` 后缀。
- **schemaVersion 门**：缺失直接拒绝并提示补 `"schemaVersion": 1`；高于本插件支持的版本拒绝并说明原因；低于则逐版迁移（当前只有版本 1）。
- **校验不查 agent**：`validate` 只验图结构与模板引用，不检查 `agent` 指向的 agent 定义是否存在；未知 id 在 run 时才报 `unknown agent "<id>"`。

## 文档级字段

- **`schemaVersion`**（整数，必填）—— 只能写 `1`。
- **`id`**（string，必填）—— 工作流标识，`^[a-z][a-z0-9-]{1,60}$`（小写字母开头，2–61 字符）。
- **`name`**（string，必填）—— 显示名，出现在 `/workflow list` 里。
- **`entry`**（节点 id，必填）—— 入口节点；入口**只能**被 `loop-back` 边指向（V2）。
- **`nodes`**（数组，必填）—— 至少 1 个，上限 200（V14）。
- **`edges`**（数组，必填）—— 可为空数组，上限 800（V14）；单节点出边上限 32。
- **`description`**（string，可选）—— 纯说明。
- **`defaults`**（对象，可选）—— 文档级默认：`nodeTimeoutMs`（默认 `600000`，未接线）、`maxAttempts`（默认 `2`，生效）、`edgeMaxBytes`（默认 `64000`，生效）。
- **`outputs`**（对象，可选）—— `{ 名字: 模板 }`，Run 结束时按最终 frame 渲染，进 Run summary，并作为 `subworkflow` 调用方的返回值。

## 节点字段

每个节点都有的通用字段：

- **`id`**（string，必填）—— 节点标识，命名规则同工作流 id，文档内唯一（V1）。
- **`kind`**（枚举，必填）—— `input` / `agent` / `script` / `tool` / `router` / `join` / `loop` / `subworkflow` / `output` / `note`。
- **`timeoutMs`**（正整数，可选）—— 单节点墙钟预算；**当前引擎未接线**，见「当前实现状态」。
- **`maxAttempts`**（≥1 整数，可选）—— 单节点尝试上限；**当前引擎未接线**，实际用 `defaults.maxAttempts`。

### `input` —— 声明 Run 输入

- **`params`**（数组，默认 `[]`）—— 每个参数：`name`（必填）、`required`（默认 `false`）、`default`（可选，调用方没给值时使用）。
- 节点本身的 output 是 `undefined`；下游一律用 `{{input.<name>}}` 读取，不要写 `{{nodes.<inputId>}}`。
- 声明的必填参数缺失时，Run 在启动阶段失败：`missing required run inputs: <names>`。

### `agent` —— 委派一次子智能体

- **`agent`**（string，必填）—— `agents/` 里的 agent 定义 `id`。
- **`task`**（模板，必填）—— 交给子智能体的任务文本。
- **`context`**（默认 `'none'`）—— 上游内容如何进入任务：`none`（默认，**只发 task，不带任何入边载荷**）、`{ "lastMessages": n }`（带上最近 n 条入边载荷）、`{ "from": "run-input" }`（任务末尾追加 `Run inputs: <JSON>`）、`{ "from": "memory" }`（任务前加 `[workflow memory]` 段）。
- **`self`**（boolean，默认 `false`）—— 为 `true` 时子激活挂在发起会话而不是 Run 根会话，用户可继续对话；此时 `context` 不能是 `none`（V16）。运行时也可用 `--self <nodeId>` 指定某节点按此处理。
- **`outputSchema`**（object，可选）—— 仅用于让下游 `json` 边通过 V12；运行期是否返回结构化结果取决于 **agent 定义文件**里的 `outputSchema`。
- 输出：有结构化结果时是对象，否则是文本。子激活非 `completed` 结束即节点失败（Run 被中止时归为 `timeout`）。

### `script` —— 跑一段命令

- **`runtime`**（枚举，必填）—— `shell` 或 `ptc`；必须在 `allowedScriptRuntimes` 白名单内（默认两者都列，但 `ptc` 运行时当前未接线）。
- **`command`** / **`script`**（二选一，必填）—— 字面命令行，或脚本正文；同时给或都不给都会被 schema 拒绝。
- **`args`**（字符串数组，默认 `[]`）—— 当前执行器未使用。
- **`stdin`**（`edges` | `none`，默认 `none`）—— `edges` 时把入边载荷拼成 stdin 传进去。
- 节点输出是该命令的 stdout（上限 1 MB）。非零退出、超时（`scriptTimeoutMs`，默认 120000）都会让节点失败，stderr 尾部进错误信息。

### `tool` —— 调一个宿主工具

- **`tool`**（string，必填）—— 宿主工具名。
- **`args`**（对象，默认 `{}`）—— 每个值是模板，渲染后作为工具参数。
- **当前宿主装配没有注入工具执行器**，运行到该节点会失败（`tool nodes need a tool executor`），见「当前实现状态」。

### `router` —— 条件分支

- **`branches`**（数组，默认 `[]`）—— 每个分支：`when`（**字符串形式的 JSONLogic**）、`to`（目标节点 id）。按顺序求值，命中即走。
- **`else`**（节点 id，必填）—— 全部未命中时的目标。
- 出边必须全是 `kind: branch`，且恰有一条无 `condition` 的边指向 `else`（V6）。router 自身输出是它收到的输入文本，仅所选分支的边把它继续往下传。
- 运行期只执行命中的那一个分支目标；同一次路由的其它分支目标被标记 `skipped`，其独占下游随之级联跳过。

### `join` —— 汇聚

- **`strategy`**（枚举，必填）—— `all`（等全部上游）、`any`（首个到达即决定）、`quorum`（到达数达到阈值即决定）。
- **`quorum`**（≥1 整数，可选）—— `quorum` 策略的阈值，默认等于上游数量。
- **`failFast`**（boolean，默认 `false`）—— 当前引擎未读取。
- 入边必须全是 `kind: fan-in`，出边必须全是 `kind: flow`（V7）。输出是**已到达**上游载荷按文档顺序拼接的 `[from <nodeId>]` 段落，每个上游一段。
- 上游失败时的行为按策略区分：`any`/`quorum` 只要仍有足够上游可能到达就照常执行（已失败的上游不计入），`all` 遇到任一上游阻塞（失败/跳过/取消）即被跳过。

### `loop` —— 循环

- **`body`**（节点 id，必填）—— 循环体入口；不能是 loop 自己（V10）。
- **`until`**（对象，必填）—— `{ "expr": "<JSONLogic 字符串>" }`，每轮结束对 `{ input, nodes, edges }`（本轮 body 的结果）求值，为真则收敛。
- **`maxIters`**（≥1 整数，必填）—— 轮数上限。
- **`onMaxIters`**（枚举，默认 `fail`）—— `fail`（抛错）/ `continue`（照常继续下游）/ `stop`（停止该循环并继续）。
- **`carry`**（边 id 数组，可选）—— 轮间回带的 **loop-back 边 id**；默认取本循环的全部 loop-back 边。每轮结束后按这些边在本轮记录的载荷序列化作为下一轮输入，首轮用 loop 的入边文本。
- **`emit`**（边 id 数组，可选）—— 循环对外输出所取的边 id；默认取 `carry` 的序列化值（即以 `\n\n` 连接）。取不到的 id 被丢弃；`emit` 指向的边必须在本轮被记录（通常是 loop-back 边）。
- 循环体只在循环内部执行：每个调度作用域（顶层与每个循环轮）开始调度前，都会把该作用域内各 loop 的 body 闭包节点预标记为 `skipped`，所以 `loop -> body` 的 flow 边不会让 body 在同一层再跑一次；嵌套循环的内层 body 也因此不会在每一外轮额外多跑一次。
- 循环体必须闭合：只有 loop 节点自己可以跨边界连边（V15），loop-back 边必须落在某个 loop 节点上且起点在 body 内（V9）。

### `subworkflow` —— 调另一个工作流

- **`workflow`**（工作流 id，必填）—— 目录里另一个文档的 `id`（V11 校验存在性，并检查引用环）。
- **`inputs`**（对象，默认 `{}`）—— 每个值是模板，作为子工作流的输入。
- 输出是子工作流 `outputs` 渲染后的映射。**注意：命令层校验目前必然以 V11 拒绝含 `subworkflow` 的文档**，见「当前实现状态」。

### `output` —— 终结点

- **`value`**（模板，必填）—— Run 输出值。
- 不允许有出边（V4）；文本非空时同时写成 `artifacts/<nodeId>/output.md`。

### `note` —— 注释

- **`text`**（string，必填）—— 纯说明文字。
- 既不允许入边也不允许出边（V4），只为可读性存在。

## 边字段

- **`id`**（string，必填）—— 文档内唯一，命名规则同节点 id。
- **`from`** / **`to`**（节点 id，必填）—— 端点必须存在（V3）；不允许自环。
- **`kind`**（枚举，必填）—— `flow`（普通）、`branch`（router 出边）、`fan-out`、`fan-in`（join 入边）、`loop-back`（必须回到 loop 节点）、`error`（失败兜底：最多一条，且不能指向 `join`/`loop`，V17）。
- **`error` 边的激活语义** —— 只在来源节点失败时激活：来源成功、或其所有来源都已结算且无一失败时，其目标被标记 `skipped`。error 边只选择一个报告/恢复节点，**不改变 Run 结果**——来源失败时 Run 仍以 `failed` 结算。
- **`format`**（枚举，默认 `text`）—— `str`（压成单行）/ `text` / `md`（加 markdown 提示头）/ `json`（要求上游是声明了 `outputSchema` 的 agent 节点，V12）。
- **`label`**（string，可选）—— 仅用于展示与 mermaid。
- **`select`**（string，可选）—— schema 接受但引擎未实现；要改载荷请用 `template`。
- **`template`**（模板，可选）—— 覆盖默认载荷（默认载荷 = 上游节点的 output）。
- **`condition`**（JSONLogic 字符串，可选）—— 只被 router 的 `branch` 边消费；无 `condition` 的 branch 边就是 router 的 else 分支。
- **`maxBytes`**（正整数，可选）—— 单边载荷字节预算，默认 `defaults.edgeMaxBytes`（64000）；超限截断并显式标记 `[truncated: ...]`。

边载荷在 journal 的 `node-input` 记录里以 `[edge a -> b | format=md | 1.2KB]` … `[/edge]` 的形式出现；agent 节点只有在 `context` 允许时才把这段载荷并入任务文本。

## 模板

写在 `task`、`output.value`、`tool.args` 的值、`subworkflow.inputs` 的值、边 `template`、文档 `outputs` 里，语法 `{{ 引用 }}`：

- **`{{input.<name>}}`** —— Run 输入。
- **`{{nodes.<nodeId>}}`** —— 某节点的输出值。
- **`{{edges.<edgeId>}}`** —— 某条边的载荷值。
- **`{{memory}}`** —— 该工作流的长期记忆全文；记忆关闭或不存在时为空串。

求值只是字符串替换加点路径读取，不执行任何表达式；引用不存在会在校验期被 V13 拒绝，运行期解析为空才渲染成空串。

## 条件表达式

`router` 的 `when`、`loop.until.expr` 使用 JSONLogic 子集，以**字符串**形式书写，解析后再静态校验：

```yaml
branches:
  - when: '{"==": [{"var": "input.mode"}, "fast"]}'
    to: fast
else: slow
```

- 可用算子：`var`、`!`、`==`、`!=`、`>`、`<`、`in`、`and`、`or`。
- `var` 读取 `input.*` / `nodes.*` / `edges.*` 点路径。
- 未知算子、算子参数个数不符、`var` 非字符串路径都会被拒绝。

## 校验规则

`validate` 与 `run` 前都会跑完整集合，任何一条失败都拒绝整个文档。

| 规则 | 内容 |
| --- | --- |
| V1 | 节点/边 id 全局唯一且符合 `^[a-z][a-z0-9-]{1,60}$` |
| V2 | `entry` 是存在的节点，且只允许 `loop-back` 边指向它 |
| V3 | 每条边两端都存在，且不是自环 |
| V4 | `output`/`note` 无出边；其它节点必须有出边；`note` 无入边 |
| V5 | 每个节点都能从 `entry` 到达 |
| V6 | router 出边全是 `branch`，且恰有一条无条件的边指向 `else` |
| V7 | join 入边全是 `fan-in`，出边全是 `flow` |
| V8 | 去掉全部 `loop-back` 边后图无环 |
| V9 | `loop-back` 边必须落在 `loop` 节点上，且起点在该 loop 的 body 内 |
| V10 | loop 的 `body` 是存在的节点，且不是 loop 自己 |
| V11 | `subworkflow.workflow` 可解析，且引用图无环（无 catalog 时直接报错） |
| V12 | `format: json` 的边要求上游是带 `outputSchema` 的 agent 节点 |
| V13 | 所有模板引用指向存在的 input 参数、节点或边（`memory` 例外） |
| V14 | 规模上限：200 节点 / 800 边 / 单节点 32 条出边 |
| V15 | loop body 闭合：只有 loop 节点允许跨边界连边 |
| V16 | `from: run-input` 需要文档有 input 节点；`lastMessages` 为正整数；`self` 节点的 `context` 不能是 `none` |
| V17 | `error` 边最多一条，且不能指向 `join`/`loop` |

## 完整示例

```yaml
schemaVersion: 1
id: parallel-review
name: Parallel review
description: 两路并行调研后汇总。
entry: start
nodes:
  - id: start
    kind: input
    params: [{ name: topic, required: true }]
  - id: facts
    kind: agent
    agent: researcher
    task: "研究：{{input.topic}}"
  - id: risks
    kind: agent
    agent: reviewer
    task: "找出风险：{{input.topic}}"
  - id: merge
    kind: join
    strategy: all
  - id: done
    kind: output
    value: "{{nodes.merge}}"
edges:
  - { id: start-to-facts, from: start, to: facts, kind: fan-out }
  - { id: start-to-risks, from: start, to: risks, kind: fan-out }
  - { id: facts-to-merge, from: facts, to: merge, kind: fan-in }
  - { id: risks-to-merge, from: risks, to: merge, kind: fan-in }
  - { id: merge-to-done, from: merge, to: done, kind: flow }
outputs:
  report: "{{nodes.done}}"
```

保存为 `workflows/parallel-review.yml` 后：

```text
/workflow validate workflows/parallel-review.yml
/workflow run parallel-review --input topic="deepseek harness"
```

JSON 与 YAML 等价，同一文档两种写法都会被接受。

## 运行时行为与产物

- `run` 在独立的 Run 根会话里执行（路由默认继承发起会话的 provider/model，`runRootProvider` / `runRootModel` 可覆盖），完成或失败后向发起会话发一条 follow-up：runId、各节点一行摘要、产物路径与 `dsh-resource://` 链接。
- 每次 Run 一个目录：`<runsDir>/<runId>/` 下 `workflow.json`（启动时快照）、`journal.jsonl`（全部事件）、`artifacts/<nodeId>/`（节点产物）。`persistRuns: false` 时只留内存态 journal。
- 侧栏看板展示活跃 Run 与最近 `recentRuns`（默认 5）个已结束 Run：节点状态、耗时、输出预览（`wirePreviewBytes`，默认 2048）、错误详情、入边载荷；工具栏可复制/下载 mermaid。
- Run 级预算：`runTimeoutMs`（默认 1800000 ms）与 `maxSteps`（默认 200，跨帧累计）。
- 重试：仅 `transient`/`timeout` 类失败可重试，上限 `defaults.maxAttempts`；`deterministic` 与 `auth` 永不重试；工具错误码还需在 `retryableToolErrors` 白名单里（默认空 = 不重试）。
- 长期记忆：Run 启动时读入 `<memoryDir>/<workflowId>.md`（默认 `.dsh/xl-build/memory/`），只经 `{{memory}}` 与 `context: { "from": "memory" }` 进入模型；Run 结算后由 `memoryCurator`（默认内置 `memory-curator`）策展一次并写回。`memoryEnabled: false` 时整条链路跳过。

## Python DSL

`.py` 定义由插件自带的 `xl_build` 包编译，插件只读编译产物：

```sh
python py/xl_build build my-flow.py -o workflows/my-flow.json
# 等价：把 py/ 加入 PYTHONPATH 后
python -m xl_build build my-flow.py -o workflows/my-flow.json
```

```python
from xl_build import Workflow

workflow = Workflow(id="py-chain", name="Python chain")
workflow.input("start", params=[{"name": "topic", "required": True}])
workflow.agent("research", agent="researcher", task="Research: {{input.topic}}")
workflow.output("done", value="{{nodes.research}}")
workflow.edge("start", "research")
```

编译产物必须是合法的 schemaVersion 1 文档，否则加载时报同样的校验错误。

## 当前实现状态

schema 接受、但引擎当前不消费或直接失败的字段/路径，写工作流时请绕开：

| 项目 | 实际情况 |
| --- | --- |
| `tool` 节点 | 宿主未注入工具执行器，运行即失败：`tool nodes need a tool executor, which this host did not wire` |
| `script` 的 `runtime: ptc` | PTC 运行时未接，运行即失败；只有 `shell` 可用 |
| `script` 的 `args` | schema 接受，执行器未使用 |
| `script` 的 `command`/`script` 模板 | `{{...}}` 只影响日志里的 node-input 文本；真正执行的命令是原文，动态内容请走 `stdin: edges` |
| `subworkflow` 节点 | 命令层校验未传 workflow catalog，V11 必然报 `cannot verify subworkflow ...`，`validate`/`run` 都会被拒 |
| 节点 `timeoutMs`、`defaults.nodeTimeoutMs` | 引擎未计时；节点耗时只受 Run 级 `runTimeoutMs` 与 agent 定义里的 `timeoutMs` 约束 |
| 节点 `maxAttempts` | 引擎只用 `defaults.maxAttempts`（每节点覆盖未接线） |
| `join.failFast` | 未读取 |
| 边 `select` | 未实现；要改载荷用边 `template` |
| agent 节点 `outputSchema` | 仅参与 V12 校验；结构化输出取 agent 定义里的 `outputSchema` |
| `/workflow validate` 与 agent 存在性 | 不检查 `agent` id 是否存在，run 时才报 `unknown agent "<id>"` |

## 目录与配置覆盖

`workflowsDir` 默认 `workflows`，相对 `dsh` 进程工作目录；可在 profile 的 `cordis.yml` 覆盖（入口 id 见 `cordis.patch.yml`）：

```yaml
- id: xl-build
  config:
    workflowsDir: D:\work\my-workflows
    runsDir: D:\work\my-workflows\.runs
```

相关配置项：`workflowsDir`、`runsDir`、`maxConcurrentNodes`、`maxSteps`、`runTimeoutMs`、`scriptTimeoutMs`、`allowedScriptRuntimes`、`retryableToolErrors`、`persistRuns`、`recentRuns`、`wirePreviewBytes`、`memoryEnabled`、`memoryDir`、`memoryMaxBytes`、`memoryCurator`、`runRootProvider`、`runRootModel`。

## 示例工作流的调用命令

本目录随附示例工作流 `xl-build-pipeline`：`input(goal)` → `manager` 出执行计划 → `worker` 与 `scripting-engineer` 并行实现 → `join` 汇总 → `reviewer` 只读复核 → `output`。`xl-build-pipeline.yml` 与 `xl-build-pipeline.json` 内容逐字段一致，`xl-build-pipeline.py` 是 Python DSL 源码（目录扫描不识别 `.py`，须先编译）。四个 `agent` 引用（`manager` / `worker` / `reviewer` / `scripting-engineer`）都是包内置定义，无需额外配置。

运行前提：无需配置——本目录作为内置工作流目录随包加载，`run` / `list` / `export` 在用户目录之外自动回落到这里（用户目录同 id 的文档覆盖内置版本，见「目录与文件约定」）。`validate` 按文件路径校验，路径相对 `dsh` 进程工作目录解析，示例路径按实际安装位置调整前缀。

| 命令 | 作用 |
| --- | --- |
| `/workflow validate <插件目录>/workflow/xl-build-pipeline.yml` | 校验一个文档文件；通过回答 `Valid: xl-build-pipeline (7 nodes, 7 edges)`，失败逐条列出 `V<n>: <原因>`。`.json` 产物同理 |
| `/workflow run xl-build-pipeline "<目标>"` | 按文档 `id` 运行；位置参数填进文档里唯一未填的声明输入（这里等价 `--input goal=<目标>`），多输入文档用 `--input k=v`。命令立即返回 `started run <runId> for <id>`，结束时向发起会话发 follow-up |
| `/workflow run xl-build-pipeline "<目标>" --self plan` | 加 `--self <nodeId>` 后该节点挂在发起会话执行，用户可继续对话 |
| `/workflow list` | 列出 `workflowsDir` 下全部文档（`- <id>: <name> (n nodes, m edges)`）；坏文件显示 `invalid — <错误>`，不影响其它文件 |
| `/workflow export xl-build-pipeline --mermaid` | 输出该工作流的 mermaid 拓扑 |
| `python py/xl_build build workflow/xl-build-pipeline.py -o workflow/xl-build-pipeline.py.json` | 把 `.py` DSL 源码编译成插件可读的 JSON；改过源码后重跑，再对产物执行 `validate` |
| `python -m xl_build build <script>.py -o <out>.json` | 上一行的等价形式，需先把 `py/` 加入 `PYTHONPATH` |

`yml` 与 `json` 同 id 共存时：用户目录里 `run` 取扫描顺序的第一个有效文档；内置目录里同 id 按文件名字序去重。两者内容一致，行为无差别。
