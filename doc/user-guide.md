# dsh-xl-build 使用指南

声明式子智能体、图式工作流编排与运行看板，[DeepSeek Harness](https://www.deepseek.com) 的独立第三方插件。设计权威见 [doc/plan.md](plan.md)；本文只讲安装与使用。

## 安装

前置要求：已安装的 `dsh`（profile 提供 `tools`、`commands`、`sessionProjections`、`subagents` 注入，标准 `web`/desktop profile 均满足）；编译 Python DSL 需要 Python 3.9+（可选；无第三方依赖；只用 JSON/YAML 时不需要）。

```sh
dsh plugin --profile web add <path-to-dsh-xl-build>
```

或在 profile 的 `package.json` 手工声明依赖后重启：

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

安装后重启 `dsh web`，输入 `/workflow list` 应回答 `No workflows are saved.`（而非报错），会话侧栏出现运行看板。源码方式开发时，在插件目录执行 `npm install && npm run build` 构建。

## 三种入口

分工固定（[plan.md](plan.md) §5.4）：**注册工具 = 模型自决，@提及 = 用户显式指定执行者，`/workflow` = 用户驱动整图。** 三者不合并、不设开关。与 agent preset 委派路径（`xl_subagent` / `agent_preset`）的逐维度效果对照见 [delegation-paths.md](delegation-paths.md)。

1. **工具 `xl_agent_list` / `xl_agent_run`**：模型可自主调用。`xl_agent_list` 只返回 `id`/`name`/`description`（不泄露 prompt），模型据此挑选执行者并委托单个任务。
2. **@提及**：输入框里 `@研究 查一下……` 即用户点名。解析与定向发生在本步并写入日志（第一条指令是“本步第一个动作必须是调用 `xl_agent_run`”），真正执行永远走工具——不存在静默触发副作用。
3. **`/workflow` 命令**：用户直接驱动工作流图：

```text
/workflow list                            # 列出已保存工作流（含解析失败文件及其错误）
/workflow validate <file>                 # 校验一个 .json/.yml/.py 定义
/workflow run <id> ["<single input>"] [--input k=v ...] [--self <nodeId>]   # 位置参数填唯一未填的声明输入
/workflow export <id> --mermaid           # 导出 plan.md §6.6 的 mermaid 文本
```

`run` 默认开独立会话执行整张图；运行完成会向发起会话发一条 follow-up（runId + 摘要 + 产出链接）。`--self <nodeId>` 把该节点标记为 `self: true`——子智能体在父会话可见、可继续对话（注意下文“self 的记忆限制”）。

运行看板（会话侧栏）展示活跃 Run 与最近已结束 Run：节点状态、耗时、输出预览、错误详情、入边载荷；节点产物一行是 `dsh-resource://` 链接，点击在侧栏打开；工具栏可复制/下载 mermaid。

## 工作流定义

定义放在 `workflowsDir`（默认 `workflows/`，相对 dsh 进程工作目录），支持 `.json`、`.yml`、`.yaml`；`run <id>`/`export <id>` 按文档里的 `id` 字段匹配，与文件名无关。包内 `workflow/` 目录随包作为**内置目录**参与解析：用户目录优先（同 id 的有效文档覆盖内置文档），内置条目在 `list` 输出里带 `(builtin)` 标记；内置文件损坏视为打包错误，插件加载直接失败。schemaVersion 门（[plan.md](plan.md) §6.7）：缺失版本直接拒绝并提示补 `"schemaVersion": 1`；高于本插件支持的版本拒绝并说明原因；低于时逐版本 `migrate()` 升级。

完整示例（与 [test/fixtures/release-demo.json](../test/fixtures/release-demo.json) 逐字一致，该文件被测试套件实际加载与校验）：

```json
{
  "schemaVersion": 1,
  "id": "release-demo",
  "name": "Release demo",
  "description": "The user-guide example: research a topic, then draft the report.",
  "entry": "start",
  "nodes": [
    { "id": "start", "kind": "input", "params": [{ "name": "topic", "required": true }] },
    { "id": "research", "kind": "agent", "agent": "researcher", "task": "研究主题：{{input.topic}}，输出要点清单。" },
    { "id": "draft", "kind": "agent", "agent": "writer", "task": "根据下面的研究结果起草报告：\n{{edges.research-to-draft}}" },
    { "id": "done", "kind": "output", "value": "{{nodes.draft}}" }
  ],
  "edges": [
    { "id": "start-to-research", "from": "start", "to": "research", "kind": "flow", "format": "text" },
    { "id": "research-to-draft", "from": "research", "to": "draft", "kind": "flow", "format": "md" },
    { "id": "draft-to-done", "from": "draft", "to": "done", "kind": "flow", "format": "md" }
  ],
  "outputs": { "report": "{{nodes.draft}}" }
}
```

节点种类：`input` / `agent` / `script` / `tool` / `router` / `join` / `loop` / `subworkflow` / `output` / `note`；边种类：`flow` / `branch` / `fan-out` / `fan-in` / `loop-back` / `error`。字段与校验规则以 [doc/plan.md](plan.md) §6 为准（V1–V17）。

### Python DSL

`.py` 定义通过插件自带的 `xl_build` 包编译成 JSON 后加载——**插件只读编译产物，从不解析 Python 源码**；目录扫描不含 `.py`，编译产物放进 `workflowsDir` 即可被 `run`/`export` 使用：

```sh
python py/xl_build build test/fixtures/py-chain.py -o tmp.json
```

等价形式：把 `py/` 加入 `PYTHONPATH` 后可用 `python -m xl_build build ...`（插件内部的加载器即此调用；无 Python 时该加载校验测试自跳过）。DSL 覆盖全部节点种类，链式调用：

```python
from xl_build import Workflow

workflow = Workflow(id="py-chain", name="Python chain")
workflow.input("start", params=[{"name": "topic", "required": True}])
workflow.agent("research", agent="researcher", task="Research: {{input.topic}}")
workflow.output("done", value="{{nodes.research}}")
workflow.edge("start", "research")
```

## self 的记忆限制

`self: true` 的 agent 节点在本会话的子智能体目录里可见、可被用户继续对话，但**子智能体不会继承父会话的聊天历史**（子激活是全新会话）。上下文注入只有一个通道：节点的 `context` 字段——`none`（默认）、`{ "lastMessages": n }`（父会话最近 n 条）、`{ "from": "run-input" }`（Run 输入）。`self: true` 不允许取 `none`（校验规则 V16）；`{ "from": "memory" }` 与 `{{memory}}` 模板变量注入工作流长期记忆（见下文「长期记忆」；依据 [plan.md](plan.md) §6.8）。

## 长期记忆

同一工作流的多次 Run 共享一份记忆文件：`<memoryDir>/<workflowId>.md`（默认 `.dsh/xl-build/memory/<workflowId>.md`）。

- **读**：Run 启动时读入全文（文件不存在即空），截断到 `memoryMaxBytes`，只通过两处显式通道进入模型：模板变量 `{{memory}}` 与 `context: { "from": "memory" }` 的前导注入。注入量记录在 run-start 事件的 `memoryBytes` 字段；Run 中途不再读盘。
- **写**：Run 结束并发完 follow-up 后，发起**一次**策展激活（agent spec 由 `memoryCurator` 指定，内置 `memory-curator`，同名用户定义优先）。输入是本次 Run 的摘要加当前记忆全文，输出必须是 `{ "memory": string }`；成功且不超 `memoryMaxBytes` 才原子写回（临时文件 + 重命名）。
- **失败保留**：超时、拒答、输出结构不符、超限、写盘失败——任何失败都保留旧记忆，并向 Run 会话发一条 `memory-updated` `{ outcome: "kept", reason }` 记录，不影响已结算的 Run 结果。策展成功时记录 `{ outcome: "updated", bytes }`。
- **并发**：同一工作流多个 Run 的策展按发起顺序排队执行；`memoryEnabled: false` 时整条链路跳过——不读不写，`{{memory}}` 解析为空且不报错（工作流可跨部署复用）。
- **范围与成本**：只有工作流 Run 读写记忆；`xl_agent_run` 工具与 @提及路径从不读写。每个结束的 Run 固定多一次策展模型调用，策展输出受 `memoryMaxBytes` 约束。
- **手工编辑**：记忆文件是普通 Markdown，可手工查看、编辑或删除；策展每次读盘，改动在下一次 Run 启动时生效，删除文件即清空该工作流的记忆。

## 与内置 workflow 工具的分工

仓库自带的 `workflow` 工具是**脚本式**编排：模型现写一段 PTC 脚本，用 `agent()`/`parallel()`/`pipeline()` 组合，适合一次性的 fan-out。本插件是**图式**编排：拓扑声明式落盘、节点级状态与边载荷可见、join/quorum 与 loop 收敛是引擎语义、每次 Run 有独立目录与产物。两者并存：本插件不注册 `ctx.workflowEngine`，不会顶替内置路径；脚本式 fan-out 用内置 `workflow` 工具，图式编排用本插件（决策依据 [plan.md](plan.md) §6.5）。

## Config 全表

每个字段都可在 `cordis.yml` 的插件 `config` 覆盖；`src/host/config.ts` 的 schema 默认值是唯一真源。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `agentsDir` | `agents` | 子智能体定义文件目录（`*.yml`/`*.yaml`/`*.json`，热重载） |
| `workflowsDir` | `workflows` | 工作流定义目录 |
| `runsDir` | `.dsh/xl-build/runs` | Run 产物目录（`persistRuns` 开启时） |
| `maxConcurrentNodes` | `4` | 单个 Run 内同时执行的节点数 |
| `maxConcurrentAgentTools` | `4` | `xl_agent_run` 路径同时未结算的激活数 |
| `runTimeoutMs` | `1800000` | 单个 Run 的墙钟预算 |
| `maxSteps` | `200` | 单个 Run 的引擎步数上限（跨帧累计） |
| `scriptTimeoutMs` | `120000` | 单个 script 节点的墙钟预算 |
| `allowedScriptRuntimes` | `['shell', 'ptc']` | script 节点允许请求的 runtime 白名单 |
| `retryableToolErrors` | `[]` | 允许重试的工具错误码；空数组表示从不重试 |
| `wirePreviewBytes` | `2048` | 投影里单个节点输出预览的字节预算 |
| `recentRuns` | `5` | 投影保留的已结束 Run 数 |
| `persistRuns` | `true` | 结束的 Run 是否落盘到 `runsDir` |
| `memoryEnabled` | `true` | Run 结束后是否蒸馏长期记忆（关闭时整条记忆链路跳过） |
| `memoryDir` | `.dsh/xl-build/memory` | 记忆文件目录，每个工作流一个 `<id>.md` |
| `memoryMaxBytes` | `16000` | 单个工作流记忆文件的字节上限（读截断与写门槛共用） |
| `memoryCurator` | `memory-curator` | 策展记忆的 agent spec id（内置定义，同名用户定义优先） |
| `presetIdPrefix` | `xl-` | 把每个 agent spec id 注册为 dsh agent preset 时前置的命名空间 |
| `runRootProvider` | `spawn` | `/workflow run` 休眠根会话的 provider |
| `runRootModel` | （provider 默认） | 覆盖根会话的模型 id |

## 产出与链接行为

- 每次 Run 独立目录：`<runsDir>/<runId>/` 下 `workflow.json`（启动时快照）、`journal.jsonl`（全部事件）、`artifacts/<nodeId>/`（节点产物文件）。`persistRuns: false` 时只保留内存态 journal。
- 节点产物以 `dsh-resource://file/session/<会话>/<runsDir>/<runId>/...` 地址出现在看板节点详情里，点击经侧栏打开；地址由宿主生成，客户端原样打开。
- 运行完成向发起会话发 follow-up：文本含 runId、各节点一行摘要、产物路径与链接。
- mermaid 文本由宿主按 [plan.md](plan.md) §6.6 的固定投影生成（`/workflow export` 与看板工具栏的复制/下载 `.mmd` 同一来源），形状不随版本漂移。
- 看板输出预览按 `wirePreviewBytes` 截断；完整输出在产物文件与 journal 里。

## 示例：从零跑通 release-demo

1. 保存两个子智能体定义到 `agents/`（字段与 README 的 agent 段一致；[test/fixtures/agents/](../test/fixtures/agents/) 有同样的文件，被测试套件解析）：

```yaml
id: researcher
name: Researcher
description: 收集资料并输出要点清单。
prompt: You are a researcher. Investigate the given topic and output a concise bullet list of findings.
```

```yaml
id: writer
name: Writer
description: 根据研究结果起草报告。
prompt: You are a writer. Draft a short report from the research provided in the input.
```

2. 把上文示例 JSON 存为 `workflows/release-demo.json`。`/workflow validate workflows/release-demo.json` 应回答 `Valid: release-demo (4 nodes, 3 edges)`；`/workflow export release-demo --mermaid` 输出：

```text
flowchart TD
  start(["input"])
  research["researcher"]
  draft["writer"]
  done[("output")]
  start -->|text| research
  research -->|md| draft
  draft -->|md| done
```

（这段文本由 `toMermaid` 对同一 fixture 实际生成，并锁定在 `test/examples.spec.ts` 断言里。）

3. `/workflow run release-demo --input topic="deepseek harness"` 启动；命令立刻回答 `started run <runId> for release-demo`，看板实时展示节点状态，结束时发起会话收到 follow-up。

第 3 步需要已安装的 dsh 与可用模型（人工验收项）；第 1–2 步的全部产物已被 `test/examples.spec.ts` 与 `test/loaders.spec.ts` 实际执行。

## 构建

```sh
npm install    # 一次
npm run build  # clean -> tsc -> tsdown -> node tests -> vitest specs
```

`tools/build.mjs` 通过库 API 调 tsc/tsdown（沙箱 shell 禁止子进程 spawn）。`lib/` 是构建产物；全新克隆先 `npm install`。
