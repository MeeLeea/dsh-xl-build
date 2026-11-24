# 两种委派路径效果对比

同一个 `agents/*.yml` 定义有两条到达子会话的路径：**规格直跑**（`@提及` / `xl_agent_run` / workflow `agent` 节点）与 **agent preset**（注册进宿主后经内置委派工具的 `agent_preset` 参数调用）。本文逐维度对比两者的实际效果、适用场景与相互影响。分工总则见 [user-guide.md](user-guide.md)「三种入口」；设计权威见 [plan.md](plan.md)。

- 状态标注：**路径一**为现行实现（含一处已验证的提示词缺陷，见 §1.2）；**路径二**为已定稿设计（preset 注册 + `xl_subagent` 工具实例），本文撰写时尚未实施，实施落地后本章即行为文档。
- 阅读顺序：赶时间只看 §3 对比表和 §5 选型指南。

## 1 路径一：规格直跑

### 1.1 链路

```
@manager 任务 ─┐
xl_agent_run { agent: "manager", task } ─┼─> AgentRegistry.resolveAgent(id)
workflow { kind: "agent", agent } ─┘         └─> runner: 只读前缀 + task 拼为用户消息
                                                  └─> startActivation({ provider: spec.provider })
```

三条入口共用同一个 runner 与准入闸门（`maxConcurrentAgentTools`，FIFO 排队）。`@提及` 在输入步就完成解析并注入指令（第一条动作必须是调 `xl_agent_run`），不存在静默触发。

### 1.2 字段如何生效（含现状缺陷）

| YAML 字段 | 路径一实际效果 |
| --- | --- |
| `prompt` | **现状不投递。** `buildPromptBlocks` 只拼只读声明 + task，`spec.prompt` 在源码中无任何读取点（`src/host/agents/run.ts:87`）。子会话拿到的是 `agentPreset` 组合的通用人格，不是角色提示词。README「prompt 是子激活的系统提示词」的表述与实现不符，属待修缺陷。 |
| `readOnly` | 软约束：给子任务加一句英文只读声明，工具集不变。 |
| `timeoutMs` | 生效，插件自计时，到点 dispose 并按 aborted 结算。 |
| `outputSchema` | 生效，启动前后各校验一次，子结果必须满足结构。 |
| `model` / `reasoningEffort` / `maxTokens` | 生效，映射为子激活的 `agentOptions`。 |
| `cwd` | 生效，优先级：调用参数 > spec > 父会话目录。 |
| `id` / `name` / `description` | 决定 `xl_agent_list` 返回值与 `@` 提及解析；description 是模型选型的唯一依据。 |

## 2 路径二：agent preset

### 2.1 链路

```
agents/*.yml ─> AgentRegistry 快照 ─> 调和器 ─> ctx.agentPresets.register(PresetDefinition)
                                                    （id = presetIdPrefix + spec.id，默认 xl-<id>）
模型 ─> 内置委派工具实例 xl_subagent { agent_preset: "xl-reviewer", prompt }
             └─> startActivation({ provider: "spawn", agentPreset: "xl-reviewer" })
                      └─> 子会话挂载该 preset 的组合（persona = YAML prompt 的 system prompt）
```

### 2.2 字段如何生效

| YAML 字段 | 路径二实际效果 |
| --- | --- |
| `prompt` | **生效，且是真正的 system prompt**：persona 行 `prefix: spec.prompt` + `complete: true`（与内置 `minimal` preset 同款用法）。这是该字段第一次以身份级别到达子模型。 |
| `readOnly` | **硬约束**：只读 preset 不挂 shell 工具、`tool-fs` 只开 `read`/`readImage`；无写能力可用，违反不可能发生。 |
| `timeoutMs` | 不携带。preset 模型无此字段，委派也无插件侧计时。 |
| `outputSchema` | 不携带。内置委派工具无结构化输出参数。 |
| `model` / `reasoningEffort` / `maxTokens` | 不携带。只能由模型经工具的 `model`/`reasoning_effort` 参数（`modelSelectionSettings` 开启时）现场指定。 |
| `cwd` | 不携带。由模型经工具的 `cwd` 参数每次显式传。 |
| `id` / `name` / `description` | 变成 preset 的展示字段；description 会拼进 `agent_preset` 参数的枚举描述，模型读一次工具 schema 即得全部角色清单。 |

注册时携带不了的字段会逐条 `logger.warn` 列出，能力仍以路径一为准。

## 3 逐维度对比

| 维度 | 路径一（规格直跑） | 路径二（agent preset） |
| --- | --- | --- |
| 调用者 | 模型（工具）、用户（`@`）、工作流引擎 | 模型（`xl_subagent` 工具） |
| 发现方式 | 先调 `xl_agent_list`（只回 id/name/description），多一次往返 | `agent_preset` 枚举 + 逐角色描述直接在工具 schema 里，零往返 |
| 角色提示词 | 现状不投递（缺陷，见 §1.2） | system prompt 级生效 |
| 只读 | 提示词前缀（软） | 工具裁剪（硬） |
| 结构化输出 | `outputSchema` 强制 | 无 |
| 单次激活预算 | `timeoutMs` 插件计时 | 无插件侧预算，受平台激活池约束 |
| 模型/推理强度/token 上限 | spec 固化 | 模型现场选或用子循环默认 |
| 并发控制 | 插件闸门 `maxConcurrentAgentTools`（排队） | 平台 `ActivationPool`（满即拒 `ACTIVATION_LIMIT_REACHED`，不排队） |
| 结果回投 | 宿主回父会话 | 宿主回父会话（同一机制） |
| 运行看板 | 子会话进 subagentCatalog | 同左（两条路径的子会话都出现在 Web `@` 引用源，按 label） |
| 长期记忆 | 不读写（memory 仅 workflow 路径） | 同左 |
| 热重载 | 保存即生效（150 ms 防抖），已启动的运行保留旧 spec | 同节奏调和；已挂载的会话保留旧 preset 修订 |
| 确定性 | 高：指定谁就是谁，参数全 | 概率路由：靠 description 质量；模型可能选错角色甚至选成内置 `subagent`（拿到无角色通用子代理，不报错） |
| 配置成本 | 零（装完即用） | 需 profile 提供 `agentPresets` 服务；`allowedAgentPresets` 静态枚举需随自定义 agent 扩充 |

## 4 与 `@提及` 的关系

路径二不触碰 `@` 的任何环节。两套名字空间完全隔离：`@` 按 id/name 解析 **agent registry** 并强制走 `xl_agent_run`；`agent_preset` 是 **preset registry** 的 `xl-<id>`，仅 `xl_subagent` 工具消费。`@` 的解析规则、`ambiguous-label` 报错、注入行为、超时与结构化输出语义全部不变，`xl_agent_list` 亦照旧。

## 5 选型指南

- **对话中让模型自主委派角色**（"帮我评审这个 diff"）→ 路径二。发现零成本、提示词真生效、只读是机制。
- **需要结构化结果 / 超时预算 / 固定模型** → 路径一 `xl_agent_run`。只有它支持 `outputSchema` 与 `timeoutMs`。
- **用户点名执行者** → 路径一 `@`。确定性最强。
- **多角色确定性编排**（固定顺序、结构化交接）→ workflow `agent` 节点，两条路径都不替代它。
- 两条路径并存互补，不设开关合并；`registerPresets: false` 可整体关闭路径二回到现状。

## 6 边界与副作用

- **Web 会话 preset 选择器会多出 `xl-*` 项**：客户端选择器读 `agentPresets.list()`，角色 preset 会出现在"本会话用哪个预设"下拉中；误选会把角色组合挂到主会话。缓解：`order` 排到末尾 + description 注明「委派角色用，勿作会话预设」。
- **双委派工具并存**：模型可能用内置 `subagent` 而非 `xl_subagent`，结果是无角色的普通子代理。缓解：`xl_subagent` description 写明「按命名角色委派」。
- **枚举滞后**：从 `agents/` 删除定义后，`allowedAgentPresets` 若仍列其 id，运行时报 `agent-preset/not-found`；靠 id 稳定与文档约定兜住。
- **preset id 冲突**：`xl-` 前缀若被其他插件占用，注册失败的 spec 逐条记录并跳过，其余不受影响（单文件失败隔离的既有哲学）。
- **profile 要求**：路径二要求 profile 提供 `agentPresets` 注入（标准 web/desktop 满足）；缺失时插件加载期响亮失败，Requirements 随实施更新。
