# dsh-xl-build 实现方案（施工图 v1）

依据 [`plan.md`](plan.md)（670 行，两轮评审批次后定稿）。本文只把设计拆成可执行单元，不新增设计决策；与 `plan.md` 冲突时以 `plan.md` 为准，并回来改本文。

## 0 使用约定

- 任务号 `M<里程碑>-<序号>`，一节一个任务：目标 / 产出 / 依赖 / 验收 / 完成判据。
- 依赖列只写前置任务号；标 **并行** 的任务彼此无依赖，可同批下发给不同执行者。
- 门禁命令一律在 `scratch-plugin/dsh-xl-build/` 目录内执行：`npm run build` 含 `tsc` + `tsdown` + 全部测试；只跑单测用 `npm run test:spec`；只跑某文件用 `npm run test:spec -- <name>`。仓库根 `pnpm run typecheck` / `pnpm run lint` 不覆盖 `scratch-plugin/`（独立 `package.json` 与 `devDependencies`）。
- 每个任务结束时勾掉复选框、跑该任务验收命令、把输出贴进 PR 描述，再开下一个。禁止「全部写完再跑一次」。
- 交付顺序按里程碑串行：M0 的验收条件是 M1 的输入（`Registry` 与投影必须先在），M2 产出 `RunView` 后 M3 才有东西可画。

## 1 Phase 0 结论（已核实，带位置）

### 1.1 会话投影注册

- 注册入口是 `ctx.sessionProjections.register(definition)`，`inject: ['sessionProjections']`。
- `ProjectionDefinition` 形状：`{ key, stateVersion, stateSchema, init(header), apply(state, event), wire: { viewSchema, view } }`。先例：`packages/session/working-directory/src/host/index.ts:82`、`packages/plan/plan-mode/src/host/index.ts:226`。
- 同一服务另有 `stateOf(session, key)`、`snapshot(session).values`、`checkpoint`、`onChanged`、`restore`；本插件只用 `register` 与（客户端侧）读快照。
- 结论：`plan.md` §7.1 的写法可直接落地，不需要自建广播通道。

### 1.2 `agent/pre-step` 注入

- 事件载荷：`{ agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal }`，waterfall，`next(): Promise<PreStepDecision>`。声明在 `packages/core/agent/src/runtime-types.ts:320`。
- 判定联合（`runtime-types.ts:112`）：

```ts
export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

- 注入写法就是替换 `messages` 后放行：`return next().then(d => d.kind === 'enter' ? { ...d, messages: [...d.messages, narration] } : d)`。先例 `packages/plan/plan-mode/src/host/index.ts:196-213`；拒绝先例 `packages/goal/goal-round-driver/src/host/index.ts:401`。
- `messages` 已经是本步待进入的完整消息批，`agent/pre-step` 每步都会重新给出。因此 `plan.md` §5.4.2 步 1 的「本步增量」直接取这次 `messages`，不需要自建水位；去重仍必须按 `(messageId, segmentIndex)`，因为同一条消息可能在多个步骤被重新呈现。
- 注入的文本以 `UserMessage` 追加，因此自动进 session log，满足 model-visible ⟺ logged，不必额外补事件。

### 1.3 文件超链接

- `fileAddressFor(sessionId, cwd | undefined, path)` 来自 `@deepseek-ai/dsh-util-workspace-path`（`packages/util/workspace-path`），输出 `dsh-resource://file/session/<sessionId>/<相对路径>`。
- 同包另有 `sessionFileAddress`、`absoluteFileAddress`、`parseFileAddress`、`isAbsoluteWorkspacePath`、`resolveWorkspacePath`；包是 browser-safe 的，host 与 client 都能用。
- 结论：`plan.md` §7.3 的 `ArtifactRef.path` 在 host 侧用 `fileAddressFor` 生成，前端只做 `openArtifact(ref)`，不拼路径。

### 1.4 沿用 `plan.md` §3 的接口

`plan.md` §3 表格中的 13 行全部保持有效，实现时不重新核实；本文只补 §3 未覆盖的四项：

| 能力 | 结论 |
|---|---|
| `PreStepDecision` 联合 | 见 1.2，`enter` 分支可整体替换 `messages` |
| `/` 命令入参 | `handler({ agent, rawInput })`，`rawInput` 是命令名之后的原始字符串（`packages/interaction/commands/src/host/index.ts:277,285`；解析先例 `packages/session-query/session-log-export/src/host/index.ts:83`） |
| 投影读取（客户端） | 先例 `ui-model-selection/src/client/directory.ts:160` 的 `this.projected.getSnapshot()` |
| 幂等文件寻址 | 见 1.3 |

### 1.5 唯一未决项与降级

客户端 `ClientSessionContext` 上读投影快照的访问器确切名字未核实（`plan.md` §5.4.2 已写明降级方案：host 注册只读命令，客户端经 BFF 查询候选）。不阻塞 M1：`M1-4` 第一步就在 `ui-model-selection/src/client/directory.ts:160` 处照抄可用写法；若该访问器不对外，改走降级路径，只替换 `catalogAgents(session)` 一个函数。

## 2 里程碑与依赖

```
M0 骨架 ──┬─> M1 入口 ──┬─> M2 引擎 ──┬─> M3 前端 ──┐
          │             │             │             ├─> M4 产出/导出
          └─> (投影) ────┴──────┬──────┴─────────────┘
                            └─> M5 长期记忆（依赖 M2，与 M3/M4 并行）
```

| 里程碑 | 出口条件（`plan.md` §8） | 预计任务数 |
|---|---|---|
| M0 | 改一个 yml 后 `xl_agent_list` 立刻反映；非法 yml 有可读报错且不影响其他定义 | 8 |
| M1 | 工具调用、`@` 提及、`/workflow list` 均可用；`@` 在时间线上留下 `mention-resolved` | 6 |
| M2 | 顺序 / 条件 / fan-out+join / loop 四类拓扑各有测试；V1–V17 各有负例 | 14 |
| M3 | 3 节点 fan-out 跑起来时节点与边状态实时变化；失败节点显示分类与重试次数 | 6 |
| M4 | 节点产出可点击打开；`toMermaid` 快照稳定；`python -m xl_build` 产物能直接跑 | 6 |
| M5 | 同一工作流跑两次，第二次的记忆注入含第一次的蒸馏结论；策展失败不影响 Run 结果 | 3 |

## 3 原子任务

### 3.1 M0 骨架

#### M0-1 包骨架与构建链

- 产出：`package.json`、`cordis.patch.yml`、`tsconfig.json`、`tsconfig.client.json`、`vitest.config.mjs`、`tools/clean-build.mjs`、`tools/build.mjs`、`tools/run-tests.mjs`、`README.md`、`icon.svg`、`locale/en.json`、`locale/zh.json`。
- 内容：`package.json` 带 `dsh.bundle.patch` 与 `dsh.client`（`platform: 'web'`；`inject` 模块表清单由 M0-8 定稿后回填）；`exports` 出 `.`、`./client`、`./types`、`./locale/*.json`。`locale/*.json` 只承载插件市场/管理界面的包级文案，运行时 UI 文案走 M0-8 的类型化字典，两层不混。构建链照 `dsh-agent-multi/tools` 三件套，但**不生成 typert**：本插件不使用 `@Remote`，前端数据通道是投影 `wire.view`。
- 依赖：无。
- 验收：`npm run build` 退出码 0，产出 `lib/index.js` 与 `lib/client.js`。
- 判据：`lib/` 全部由构建生成，源目录不出现手写 `.js`。

#### M0-2 Config

- 产出：`src/host/config.ts`。
- 内容：`plan.md` §5.3 全部键 + `maxConcurrentAgentTools`（见 §6.5 回写项 1）。`allowedScriptRuntimes` 用 `Schema.union(['shell', 'ptc'])` 数组。
- 依赖：M0-1。
- 验收：`npm run test:spec -- config` 断言默认值与 `cordis.yml` 覆盖生效。
- 判据：`src/` 里不出现裸 `DEFAULT_*` 常量承载上述任一可调项。

#### M0-3 事件声明

- 产出：`src/host/events.ts`。
- 内容：`declare module '@deepseek-ai/dsh-session/types'` 合并 `plan.md` §5.5 的 10 个事件；每个载荷 `{ version: 1, ... }` 并按仓库约定标 `ignorable: true`；事件名字符串集中为 `XL_EVENTS` 常量表，别处只引用常量。
- 依赖：M0-1。
- 验收：`npm run test:spec -- events` 断言事件名全集、`version` 字段存在、常量表与 `SessionEventMap` 键一致。
- 判据：全仓 `grep -c "xl-build/"` 只命中 `src/host/events.ts` 与测试。

#### M0-4 AgentSpec schema

- 产出：`src/host/agents/spec.ts`。
- 内容：`plan.md` §5.2 的 `AgentSpecSchema`，`z.infer` 导出 `AgentSpec`。`provider` 默认 `'spawn'`；`readOnly` 默认 `true`；`timeoutMs` 默认 `600_000`。没有 `tools`/`skills` 字段：`SubagentStartRequest` 无工具过滤通道，组合裁剪走 `agentPreset`（`plan.md` §5.2）。
- 依赖：M0-1。
- 验收：`npm run test:spec -- spec` 覆盖默认值、`id` 正则负例（大写、下划线、超长）、缺 `prompt`。
- 判据：`AgentSpec` 类型不在别处手写重复。

#### M0-5 Agent 目录加载与热更新

- 产出：`src/host/agents/registry.ts`。
- 内容：扫描 `<Config.agentsDir>` 下 `*.yml|*.yaml|*.json`（相对路径基于 `process.cwd()`，绝对路径原样）；单个文件失败只标 `invalid` 并把错误文本留在 `listAgents()` 结果里，不抛异常；`fs.watch` + 固定 150ms 防抖重载（本地刷新节奏，不是部署差异，故不进 Config）；`resolveAgent(id)` / `listAgents()` 是唯一解析入口；全部经 `ctx.effect()` 注册，卸载时关 watcher。
- 依赖：M0-2、M0-4。
- 验收：`npm run test:spec -- registry` 用临时目录覆盖：新增文件生效、改文件生效、坏文件只影响自身、卸载后不再重载。
- 判据：重载不替换已启动 Run 持有的快照对象（`plan.md` §5.3 第 2 条）。

#### M0-6 运行视图投影

- 产出：`src/host/projection.ts`。
- 内容：`ProjectionDefinition`（`key: 'xlBuild'`、`stateVersion: 1`、`stateSchema`、`init`、`apply`、`wire.view`），形状照 `dsh-agent-multi/src/host/projection.ts:409`。state 以 `runId` 为键；`wire.view` 只输出活跃 Run + 最近 `Config.recentRuns` 个已结束 Run，`outputPreview` 按 `Config.wirePreviewBytes` 截断；`catalog.agents` / `catalog.workflows` 由 host 写入。
- 依赖：M0-2、M0-3。
- 验收：`npm run test:spec -- projection` 覆盖事件折叠、超出 `recentRuns` 的剔除、预览截断、未知事件容错。
- 判据：`apply` 是纯函数，不读时钟、不读 Config 之外的全局状态。

#### M0-7 入口装配 + `xl_agent_list`

- 产出：`src/host/index.ts`、`src/host/agents/tool.ts`（仅 `xl_agent_list`）。
- 内容：装配 M0-2/3/5/6；注册 `xl_agent_list()`，返回 `id/name/description`，**不含 `prompt`**（`plan.md` §5.4.1）。
- 依赖：M0-5、M0-6。
- 验收：`npm run build`；`dsh plugin --profile web add <该目录>` 后在 Web 里让模型调 `xl_agent_list`，改一个 yml 再调一次，结果变化；把某 yml 改坏，其余定义仍可见且报错可读。
- 判据：`plan.md` §8 的 M0 行两个条件同时成立。

#### M0-8 客户端挂载骨架

- 产出：`src/client/index.ts`、`src/client/mount.ts`、`src/client/locales.ts`、`src/css-modules.d.ts`、`package.json`（回填 `dsh.client.inject`）。
- 内容：照 `dsh-agent-multi/src/client` 的挂载流程（见 `../../left-sidebar-develop.md` §5 七步）：入口 `export { inject }` + `apply(ctx): Promise<() => Promise<void>>`；`const PANEL_ID = 'xl-build' as MainPanelId`（类型来自 `@deepseek-ai/dsh-client-ui-layout/client`）；`declare module '@deepseek-ai/dsh-client-ui-slots'` 合并 `LocaleNamespaceMap { 'xl-build': XlBuildKey }`；服务清单 `inject = ['slots', 'locale', 'inputTriggers', ...]`（投影读取按 §1.5 定稿补最后一项）；`locales.ts` 类型化字典，`type XlBuildKey = keyof typeof zh & keyof typeof en`；`mount` 内 `ctx.inject(inject, uiCtx => registerUi(uiCtx))` 原子注入，`registerUi` 本任务只注册字典（`ctx.effect(() => ctx.locale.register(NS, { zh, en }), ...)`），M1-4 与 M3-3 的注册往里加。`package.json` 的 `dsh.client.inject` 列出所用服务对应的包名——`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-renderer`、`@deepseek-ai/dsh-client-ui-input-trigger`，加 §1.5 定稿的投影读取包；M4-2 的 `openArtifact` 若经 `ctx.sidebarRight.openResource` 落右栏预览，届时补 `@deepseek-ai/dsh-client-ui-sidebar-right`。注意它是**模块表请求不是服务注入**，槽位类型（ui-sidebar / ui-layout）走 `import type`，不进清单。样式只用 CSS Modules：`*.module.css` + `src/css-modules.d.ts` 声明，token 经模块取，不用全局选择器。
- 依赖：M0-1。
- 验收：`npm run build`；`npm run test:spec -- mount` 以 FakeLocale/Fake 服务走真实 `apply` 入口（骨架照 `dsh-agent-multi/test/mount.client.spec.ts`），断言字典注册成功、`fiber.dispose()` 后撤回。
- 判据：`apply` 返回的 disposer 按「先 UI 后依赖」清理，失败路径先回滚再抛错；客户端源无硬编码文案。

### 3.2 M1 三条入口

#### M1-1 `xl_agent_run`

- 产出：`src/host/agents/tool.ts`（补第二个工具）。
- 内容：输入见 §6.2；`delivery: 'parent'`——照 `tool-subagent`：子级被接受后工具立即返回 `childId`（结果不含执行 Promise 与输出），结算后运行时往父会话补用户角色完成通知（结尾文本 + `Structured result: <JSON>` + 诊断）；Run 引擎路径仍 `'caller'`，同一执行器 `runAgentNode(spec, input, signal, delivery)` 以参数区分（`plan.md` §5.4）。调 `ctx.subagents.startActivation({ provider, label, request: { prompt, parent: agent, cwd, agentPreset?, agentOptions?, outputSchema? }, signal, delivery })`——`SubagentStartRequest` 没有 `toolFilter` 字段（`plan.md` §3 速查表），组合裁剪只经 `agentPreset`（仅 `spawn` 后端支持）；`agentOptions` 只放 `model`/`reasoningEffort`/`maxTokens`（`AgentOptions` 的第四键 `provider` 是 LLM 路由，不从 yml 设置）；`readOnly: true` 只在 `prompt` 首块前缀只读声明，不裁剪工具。并发上限 `Config.maxConcurrentAgentTools` 统计经该工具**未结算**的激活数，超出 FIFO 排队新启动；`AgentSpec.timeoutMs` 由插件保留句柄到点 `dispose()`（结算 `aborted`，通知照常），`result` 结算后丢句柄，插件卸载对未结算句柄逐个 `dispose()`。宿主 `inject` 清单加 `'subagents'`（M0-7 装配统一列出），`package.json` 依赖 `@deepseek-ai/dsh-subagent`（`SubagentActivationSpec` 等类型）；运行前提是 profile 组合了名为 `spawn` 的 provider（web 默认组合已含）。
- 依赖：M0-7。
- 验收：`npm run test:spec -- agent-tool` 用 stub `ctx.subagents` 断言 `delivery: 'parent'`、工具结果只含 `childId`（不 await `result`）、`agentOptions` 只含 `model`/`reasoningEffort`/`maxTokens`、`request` 无 `toolFilter` 键、`readOnly: true` 时 prompt 首块带只读声明、`agentPreset` 原样透传、`timeoutMs` 到点调用 `dispose()`、未知 agent 报错列出可选项。
- 判据：工具描述包含「何时用/何时别用」两段、说明 `self` 语义限制，并照 `tool-subagent` 提示「并行发起、只剩等待时结束 turn 而不是轮询」。

#### M1-2 提及解析纯函数

- 产出：`src/host/agents/mention.ts`（导出 `parseMentions`）。
- 内容：输入本步 `messages` 中的文本与已知 agent 列表，输出按出现顺序编号的 segment：`{ segmentIndex, raw, agentId, start, end, task }`。识别用宽松正则 `<\s*xl-agent\s+id="([^"]+)"\s*\/>`；同时接受手输 `@name`；按 `id` 与 `label` 双向匹配；`task` 取「本提及结尾到下一个提及开头」，作为字面量随 segment 返回（`plan.md` §5.4.2 步 2、3）。
- 依赖：M0-4。
- 验收：`npm run test:spec -- mention-parse` 覆盖：规范 token、丢空格 token、手输 label、多提及、句中提及、提及后无文本、未知名。
- 判据：纯函数，不 import Cordis 或客户端模块。

#### M1-3 pre-step 注入

- 产出：`src/host/agents/mention.ts`（补 `ctx.on('agent/pre-step', ...)`）。
- 内容：对 `decision.kind === 'enter'` 的 `messages` 逐个解析，按 `(messageId, segmentIndex)` 去重；命中的写 `xl-build/mention-resolved`，未命中的写 `xl-build/mention-unresolved` 并保留原文；注入定向块（`agent=<id>`、`task="<字面量>"`、「本步第一个动作必须是调用 `xl_agent_run`」），多提及按序编号不合并；`next()` 结果整体替换 `messages`（见 1.2）。
- 依赖：M1-2。
- 验收：`npm run test:spec -- mention-step` 覆盖：同一条消息在两步被呈现只注入一次；同一步内同一 agent 两次提及产生两个 segment；未知名只写 unresolved 不注入。
- 判据：注入后 `messages` 长度只增不减，且原消息对象不被就地修改。

#### M1-4 客户端 `@` 触发源

- 产出：`src/client/mention.ts`、`src/client/mount.ts`（`registerUi` 补触发源注册）。
- 内容：`ctx.effect(() => ctx.inputTriggers.registerSource({ trigger: '@', name: 'xl-agent', order: 20, candidates, onPick, codec }), ...)`（`plan.md` §5.4.2 代码块），挂进 M0-8 的 `registerUi`；`catalogAgents(session)` 读投影快照，优先照 1.5 的写法；`icon` 用 `ComponentType<IconProps>`；文案键进 `src/client/locales.ts`，经 `t()` 取。
- 依赖：M0-6、M0-8、M1-2。
- 验收：`npm run build`；`pnpm dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml` 后输入 `@` 出现候选、选中后插入 `@label`、序列化为 `<xl-agent id="x" />`。
- 判据：客户端不 import host 的 `registry.ts`；组件与触发源无硬编码文案。

#### M1-5 `/workflow` 命令（list / validate）

- 产出：`src/host/commands/workflow.ts`（导出 `parseCommand`）、`src/host/workflow/loaders/json.ts`、`src/host/workflow/loaders/yaml.ts`。
- 内容：`ctx.commands.register({ name: 'workflow', ... })`；`rawInput` 解析规则见 §6.3；本任务只实现 `list` 与 `validate <file>`（`validate` 复用 M2-3 之后才完整，先只做 schema 解析与 V1–V4）。`list` 扫描 `<Config.workflowsDir>` 下的 `*.json|*.yml|*.yaml`；YAML 走 `js-yaml`。
- 依赖：M0-6、M0-7。
- 验收：`npm run test:spec -- command-parse` 覆盖 §6.3 全部形态与错误分支；手工 `/workflow list` 输出已保存工作流。
- 判据：命令 handler 不抛异常，错误一律返回用法或可读消息。

#### M1-6 M1 验收

- 产出：`test/e2e/m1.e2e.spec.ts`（无 key 自跳过）。
- 内容：一次真实模型调用里触发 `xl_agent_run`，断言父会话出现 `xl-build/mention-resolved` 与完成通知（子结尾文本与 `Structured result` 随 `'parent'` 通知送达）；`/workflow list` 走真实命令路径。
- 依赖：M1-1、M1-3、M1-5。
- 验收：`DEEPSEEK_API_KEY=... npm run test:spec -- e2e/m1`；无 key 时 `npm run build` 仍然绿。
- 判据：M1 出口三个条件同时成立（`plan.md` §8）。

### 3.3 M2 引擎

#### M2-1 WorkflowDocument 与节点判别联合

- 产出：`src/host/workflow/domain.ts`。
- 内容：`plan.md` §6.1 的 `WorkflowDocumentSchema` + §6.1 本文定稿的 `WorkflowNodeSchema` 判别联合（见 §6.1）+ `WorkflowEdgeSchema`；`z.infer` 导出全部类型。
- 依赖：M0-1。
- 验收：`npm run test:spec -- domain` 覆盖每个 kind 的正例与「字段放到错误 kind 上」的负例（如 `self` 出现在 `script`）。
- 判据：`domain.ts` 不 import 任何 Cordis 包，host 与 client 共用。

#### M2-2 表达式求值器

- 产出：`src/host/workflow/expr.ts`。
- 内容：JSONLogic 子集（`==`、`!=`、`>`、`<`、`and`、`or`、`!`、`in`、`var`）；运算符是一张闭集表，静态校验与运行时共用；不引第三方库，文件头注释写明理由（`plan.md` §6.2 末段）。导出 `evalExpr(expr, frame)` 与 `validateExpr(expr)`。
- 依赖：M2-1。
- 验收：`npm run test:spec -- expr` 覆盖九种运算、类型不匹配、未知运算符、`var` 缺失键。
- 判据：`grep` 该目录无 `eval(` / `new Function`。

#### M2-3 结构校验 V1–V14

- 产出：`src/host/workflow/validate.ts`。
- 内容：按 `plan.md` §6.4 逐条实现 V1–V14，每条错误带节点或边 id 与规则号；V8 用 Kahn 拓扑排序。
- 依赖：M2-1、M2-2。
- 验收：`npm run test:spec -- validate` 每条规则至少一个负例（V1 两条：重复 id、坏正则）。
- 判据：任一条失败即整体拒绝启动，不做「跳过继续」。

#### M2-4 边界校验 V15–V17

- 产出：`src/host/workflow/validate.ts`（补三条）。
- 内容：V15 body 子图闭合（除 `loop-back` 外不得跨 loop 边界）；V16 `context` 四态 + `self` 仅限 agent 节点；V17 `error` 边至多一条且 `to` 不得是 `loop`/`join`。需要 body 可达集合，从 `loop.body` 做一次只走非 `loop-back` 边的 BFS。
- 依赖：M2-3。
- 验收：`npm run test:spec -- validate` 三条各两个负例（跨边界出/跨边界入；`context` 两处违规）。
- 判据：V15 的报错文本点名「哪条边跨越了哪个 loop」。

#### M2-5 编译到 Plan

- 产出：`src/host/workflow/compile.ts`。
- 内容：产出 `Plan`：节点表、入边表、拓扑层、每个 loop 的 body 集合与 `carry`/`emit` 解析结果；为 body 入口补只存在于 Plan 的合成入边 `loop.in → bodyEntry`；解析 `loop.in` 端口类型（多入边须同名或经 `select` 收敛，否则编译期失败）。
- 依赖：M2-4。
- 验收：`npm run test:spec -- compile` 覆盖：拓扑层顺序、合成入边只出现在 Plan、多入边未收敛报错、`carry` 引用非 loop-back 边报错。
- 判据：`compile` 是纯函数，输出只依赖 `WorkflowDocument`。

#### M2-6 帧执行器骨架

- 产出：`src/host/workflow/engine.ts`。
- 内容：帧模型 `frame = { id, loopId?, iteration }`；帧内 `states` + `edgePayloads`；调度「入边齐备且满足触发条件」的 `pending` 节点；`maxConcurrentNodes` 并行；`maxSteps` 跨帧累计、`runTimeoutMs` 墙钟；取消传播到子激活与脚本进程；每步写 `node-start` / `node-end` / `edge-transfer`；失败按 `plan.md` §6.5 步 5 分类——模型/传输可重试，工具错误只在 `Config.retryableToolErrors` 白名单内重试，代码 bug 不重试——每次失败写 `node-error`，耗尽后转 `failed` 并走 `error` 边（若有）。
- 依赖：M2-5。
- 验收：`npm run test:spec -- engine` 用桩节点实现跑顺序与 fan-out 拓扑；断言 `maxSteps`、取消、`budget-exceeded`。
- 判据：`engine.ts` 不认识具体 kind，节点实现由注册表注入。

#### M2-7 agent 与 tool 节点

- 产出：`src/host/workflow/nodes/agent.ts`、`src/host/workflow/nodes/tool.ts`、`src/host/workflow/envelope.ts`。
- 内容：模板渲染（只做字符串替换与 JSON 取值，不执行表达式）；信封格式固定为 `plan.md` §6.3 的围栏文本，`node-input` 与模型输入共用同一个字符串；出边按 `format`/`select`/`maxBytes` 生成载荷；`json` 格式按上游 `outputSchema` 校验；`self` 决定 `parent` 取命令发起者还是 Run 会话。
- 依赖：M2-6、M1-1。
- 验收：`npm run test:spec -- nodes-agent` 覆盖信封逐字一致、四种 format、`select` 取子字段、`maxBytes` 截断标记、`outputSchema` 校验失败即边失败。
- 判据：`envelope.ts` 是唯一生成信封的地方。

#### M2-8 router 与 join

- 产出：`src/host/workflow/nodes/router.ts`、`src/host/workflow/nodes/join.ts`。
- 内容：router 依次求值 `branches[].when`，命中即取；都不命中走 `else`。join 只读本帧入边，按 `all`/`any`/`quorum(n)` 判定，`failFast` 时任一失败立即失败。
- 依赖：M2-6、M2-2。
- 验收：`npm run test:spec -- nodes-router-join` 覆盖三分支互斥、`else` 兜底、`quorum(2)`、`any` 先到先得、跨轮不污染（上一帧入边不影响本帧）。
- 判据：join 判定函数不读帧外状态。

#### M2-9 loop 节点

- 产出：`src/host/workflow/nodes/loop.ts`。
- 内容：帧栈；第 1 轮取 `in`，第 N+1 轮取 `carry`（按数组顺序映射 loop-back 边载荷）；每轮末以该帧为上下文求 `until`；`maxIters` 超出按 `onMaxIters`（默认 `fail`）处理；输出取收敛帧 `emit` 边载荷，缺省取第一条出边；嵌套 loop 的内外层 `carry` 互不可见。
- 依赖：M2-6、M2-2。
- 验收：`npm run test:spec -- nodes-loop` 覆盖：首轮 `in` / 次轮 `carry`、`until` 收敛、`maxIters` 三种 `onMaxIters`、`emit` 缺省、嵌套两层。
- 判据：loop 不修改文档，只在 Plan 与帧上工作。

#### M2-10 script 节点

- 产出：`src/host/workflow/nodes/script.ts`。
- 内容：只接受 `allowedScriptRuntimes` 内的 runtime；`shell` 走 `ctx.shell`，`ptc` 走 `ctx.ptcRuntime`；超时缺省 `Config.scriptTimeoutMs`；输出超 `maxBytes` 截断并在事件带 `truncated: true`；`stdin: 'edges'` 时把入边载荷按行喂入。
- 依赖：M2-6。
- 验收：`npm run test:spec -- nodes-script` 覆盖：runtime 白名单拒绝、超时杀进程、截断标记、`stdin` 两种取值。
- 判据：脚本逃逸只可能经 `ctx.shell` 的既有 approval，不另开旁路。

#### M2-11 subworkflow / input / output / note

- 产出：`src/host/workflow/nodes/subworkflow.ts`、`src/host/workflow/nodes/simple.ts`。
- 内容：`subworkflow` 递归启动子 Run（V11 已保证无环），`inputs` 映射进子 Run 输入；`input` 注册本次 Run 入参；`output` 收敛 `outputs` 映射；`note` 不执行也不产生边。
- 依赖：M2-6。
- 验收：`npm run test:spec -- nodes-misc` 覆盖子 Run 输入映射、`outputs` 取值、`note` 零副作用。
- 判据：子 Run 的 `runId` 进父 Run journal 的可追溯字段。

#### M2-12 加载器与版本迁移

- 产出：`src/host/workflow/loaders/json.ts`（补迁移）、`src/host/workflow/loaders/yaml.ts`（补）、`src/host/workflow/loaders/python.ts`。
- 内容：`schemaVersion` 低版本走 `migrate()`，高版本拒绝并说明原因（`plan.md` §6.7）；`.py` 走 `python -m xl_build build <file> -o <tmp.json>` 再按 JSON 读，从不解析 Python 源码；`python` 不在 PATH 时给出可读错误。
- 依赖：M2-1。
- 验收：`npm run test:spec -- loaders` 覆盖：缺 `schemaVersion`、高版本拒绝、YAML 与 JSON 等价、Python 缺解释器路径。
- 判据：加载器输出一定是 `WorkflowDocument`，不存在第二种运行时表示。

#### M2-13 journal 与续跑

- 产出：`src/host/workflow/journal.ts`。
- 内容：`<runsDir>/<runId>/` 下 `workflow.json`、`journal.jsonl`、`artifacts/<nodeId>/`；`persistRuns=false` 只留内存。续跑：已完成节点复用 journal 输出不重放；有 `node-start` 无 `node-end` 的节点标 `unknown` 并停跑（`plan.md` §6.5）。
- 依赖：M2-6。
- 验收：`npm run test:spec -- journal` 覆盖：重启后已完成节点不重放、`unknown` 停跑、`persistRuns=false` 不落盘。
- 判据：journal 每行可独立解析，坏行报出 seq。

#### M2-14 `/workflow run` 接引擎

- 产出：`src/host/commands/workflow.ts`（补 `run`）、`src/host/workflow/run.ts`。
- 内容：`run <id> [--input k=v] [--self <nodeId>]`；默认在独立 session 执行，结束后把「跑完了 + 摘要 + 产出链接」作为 follow-up 回到发起会话；`--self` 把对应节点置为 `self: true`（不改文档，只改本次 Plan）。
- 依赖：M2-9、M2-11、M2-13、M1-5。
- 验收：`npm run test:spec -- workflow-run` 用桩 provider 跑一条 3 节点链，断言 follow-up 文本含 runId 与产出链接；`/workflow validate` 对四类拓扑各一份 fixture 返回 ok。
- 判据：M2 出口两个条件成立（四类拓扑有测试 + V1–V17 各有负例）。

### 3.4 M3 前端

#### M3-1 分层布局

- 产出：`src/client/graph/layout.ts`。
- 内容：按拓扑层从左到右排布；loop body 用可见矩形聚合；纯函数，输入 `RunView` + `WorkflowDocument` 的节点/边子集，输出坐标。
- 依赖：M2-5（只需 `Plan` 的层信息格式）。
- 验收：`npm run test:spec -- layout` 对 fan-out、join、loop 三种 fixture 断言层号与不重叠。
- 判据：布局不读 React 状态。

#### M3-2 SVG 渲染

- 产出：`src/client/graph/render.tsx`。
- 内容：节点按 kind 画形状、按 `NodeStatus` 着色；边上显 `format · size` 与裁剪标记；只用项目 token 取色。
- 依赖：M3-1。
- 验收：`npm run test:spec -- render` 对固定 `RunView` 断言输出包含三个状态类名与边标签文本。
- 判据：无内联颜色字面量（走 token）。

#### M3-3 侧边栏面板

- 产出：`src/client/panel/WorkflowPanel.tsx`、`src/client/XlBuildIcon.tsx`、`src/client/mount.ts`（补两个槽位注册）。
- 内容：照 `dsh-agent-multi/src/client/mount.ts` 成对注册，两处共用 M0-8 的 `PANEL_ID`：`sidebar.panellist`（list，`id: PANEL_ID`、`order: 40`、`locale: NS`、`label: () => t('panel')` thunk）与 `main`（keyed，`key: PANEL_ID`、`locale: NS`），点击图标由侧边栏自身导航，不自己操纵 DOM；`XlBuildIcon` 照 `AgentMultiIcon.tsx` 写法——primitives 内置图标，按 `PropsRuntime<'sidebar.panellist'>` 的 `{ size, active }` 渲染；面板 props 用 `PropsRuntime<'main'> & PropsLocale<'xl-build'>`。面板是 root 作用域、无 Session 绑定，目录与 Run 数据按 §1.5 结论读取——客户端访问器若为 session 作用域，直接走降级路径（host 只读命令），只替换 `catalogAgents(session)` 一个函数。三块布局为拓扑 / 详情 / 产出；空态提示「先保存一个工作流」。
- 依赖：M3-2、M0-6、M0-8。
- 验收：`npm run build`；`pnpm dsh web` 侧边栏出现图标行、点击切换到 `main` 面板可见拓扑；`npm run test:spec -- mount` 断言两槽注册（`key` 与 `id` 同值）与卸载撤回。
- 判据：`main.key` 与 `panellist.id` 同值；label 为 thunk；`order` 与内置行及 agent-multi（30）错开；面板只读投影，不自己算状态。

#### M3-4 节点详情

- 产出：`src/client/panel/NodeDetail.tsx`。
- 内容：输入文本、输出预览、重试次数、错误分类、产出列表。
- 依赖：M3-3。
- 验收：手工跑一个失败节点，详情显示 `class` 与 `attempt`。
- 判据：M3 出口第二条成立。

#### M3-5 运行看板与会话卡片

- 产出：`src/client/panel/RunBoard.tsx`。
- 内容：产出列表按节点分组；会话时间线折叠 `xl-build/*`，规则照 `dsh-client-ui-workflow-run` 的「phase 分组 + 成员开始/结束配对 + 中断态」，不直接复用该包；Run 卡与详情含记忆行——本次注入 `memoryBytes`、结束后 `memory-updated` 的 `updated`/`kept` 与字节数（`plan.md` §6.8、§7.2）。
- 依赖：M3-3。
- 验收：`pnpm dsh web` 跑一次 3 节点 fan-out，节点与边状态实时变化。
- 判据：M3 出口第一条成立。

#### M3-6 文案

- 产出：`src/client/locales.ts`（补面板、空态、错误、边标签全部运行时键）。
- 内容：运行时 UI 文案全部经 `t()`，键进类型化字典；zh/en 键集一致由 `XlBuildKey = keyof typeof zh & keyof typeof en` 编译期保证（缺键/多键都是编译错）；侧边栏行 label 用 thunk，语言切换免重注册。`locale/*.json` 只承载包级展示文案（M0-1 已建），两层不混。
- 依赖：M3-3。
- 验收：`npm run test:spec -- locales` 断言 zh/en 键集一致、`LocaleNamespaceMap` 合并编译通过；`grep -n "[\u4e00-\u9fa5]" src/client` 只命中 `locales.ts`（zh 字典所在文件）。
- 判据：组件文件无中文字面量；`verify-client-ui-i18n` 等价检查通过（本插件不在仓库门禁内，用上述 grep 代替）。

### 3.5 M4 产出与导出

#### M4-1 产出登记

- 产出：`src/host/paths.ts`。
- 内容：把节点产出登记成 `ArtifactRef { nodeId, path, kind, bytes?, title }`，`path` 用 `fileAddressFor(sessionId, cwd, absPath)` 生成（见 1.3）；相对路径按 Run 的 cwd 解析。
- 依赖：M2-13。
- 验收：`npm run test:spec -- paths` 覆盖相对/绝对/越界路径。
- 判据：`node-end.artifacts` 与投影里的 `artifacts` 是同一批对象。

#### M4-2 文件项打开

- 产出：`src/client/panel/ArtifactList.tsx`（或并入 `RunBoard`）。
- 内容：点击走 `ui-sidebar-documentpreview`（文本类）或 `ui-sidebar-files`（其他），只调 `openArtifact(ref)`。
- 依赖：M4-1、M3-5。
- 验收：`pnpm dsh web` 点一个 `.md` 产出在预览器打开。
- 判据：M4 出口第一条成立；前端不拼路径。

#### M4-3 mermaid 导出

- 产出：`src/host/workflow/mermaid.ts`。
- 内容：`toMermaid(doc, view?)` 纯函数，形状与边样式严格按 `plan.md` §6.6 表；有 `view` 时只追加 `classDef` + `class`。
- 依赖：M2-1。
- 验收：`npm run test:spec -- mermaid` 按 `plan.md` §6.6 的示例做快照（两种输出：带 view / 不带 view）。
- 判据：M4 出口第二条成立；快照归插件本地 `test/snapshots/`，不进仓库顶层。

#### M4-4 导出动作

- 产出：`src/client/panel/ExportMermaid.tsx`。
- 内容：「复制」写剪贴板，「下载 .mmd」用 Blob 下载；文本来自 host（投影或命令查询），不在客户端重新生成。
- 依赖：M4-3、M3-3。
- 验收：手工复制与下载各一次，内容与 `toMermaid` 一致。
- 判据：client bundle 不含 mermaid 依赖。

#### M4-5 Python SDK

- 产出：`py/xl_build/__init__.py`、`py/xl_build/__main__.py`。
- 内容：`Workflow`/`Agent`/`edge` DSL，`python -m xl_build build x.py -o x.json` 产出 `WorkflowDocument` JSON；不依赖第三方包。
- 依赖：M2-1。
- 验收：`python -m xl_build build test/fixtures/py-chain.py -o tmp.json` 后 `npm run test:spec -- loaders` 能加载；无 `python` 时该测试自跳过。
- 判据：M4 出口第三条成立。

#### M4-6 文档

- 产出：`doc/user-guide.md`、`README.md`（补）、`doc/plan.md` §6.5 的分工说明引用。
- 内容：安装、三种入口、`self` 的记忆限制、与内置 `workflow` 工具的分工、Config 全表、产出与链接行为。
- 依赖：M4-2、M4-4、M4-5。
- 验收：按文档从零安装一次并跑通示例工作流。
- 判据：文档里每条命令都实际执行过。

### 3.6 M5 长期记忆

#### M5-1 记忆读取与注入

- 产出：`src/host/workflow/memory.ts`（前半：`readMemory`）、`src/host/workflow/nodes/agent.ts`（补 `{{memory}}` 白名单与 `context` 第四分支）。
- 内容：`readMemory(workflowId)` 读 `<Config.memoryDir>/<workflowId>.md`（缺失即空串），截断到 `Config.memoryMaxBytes`；`run.ts` 只在启动 Run 前读一次，`run-start` 载荷补 `memoryBytes`；`{{memory}}` 进模板引用白名单（V13 恒放行），`context: { from: 'memory' }` 为第四取值（V16 同步：`self: true` 仍不得取 `'none'`）；禁用或缺失一律解析为空，不报错（工作流跨部署共享）。
- 依赖：M2-14、M0-4。
- 验收：`npm run test:spec -- memory` 覆盖：缺失文件空串、禁用空串、超限截断、`{{memory}}` 替换、`context` 注入前导。
- 判据：Run 中途不读记忆；记忆文本只经模板与 `context` 两处进入 prompt（model-visible ⟺ logged 由 `node-input` 承载）。

#### M5-2 策展后处理

- 产出：`src/host/workflow/memory.ts`（后半：`curateMemory`）、`agents/memory-curator.yml`。
- 内容：`run-end` 与发起会话 follow-up 发出后异步启动**一次**策展激活：`runAgentNode(curatorSpec, digest + 旧记忆全文, signal, 'caller')`，curatorSpec 由 `Config.memoryCurator` 解析（内置 spec 的 prompt 即策展指令：蒸馏新知、剪枝过时、合并重复、保持上限内、全量输出），`parent` = Run 会话的 agent；digest 由 `run-end`/`node-end`/`node-error` 载荷组装（天然有界）；`outputSchema` 要求 `{ memory: string }`；插件保留句柄，`timeoutMs` 到点 `dispose()`（同 M1-1 工具路径）；成功且 ≤ `memoryMaxBytes` 原子写盘（临时文件 + rename）并写 `xl-build/memory-updated { outcome: 'updated', bytes }`；任何失败保留旧记忆、写 `{ outcome: 'kept', reason }`；同 workflow 并发结束按 workflow id FIFO 串行；`memoryEnabled = false` 整体跳过。
- 依赖：M5-1、M2-14。
- 验收：`npm run test:spec -- memory-curator` 用 stub provider 覆盖：成功写回、超时保留、超限保留、structured 不符保留、并发 FIFO、失败不改 Run 结果。
- 判据：后处理任何失败不改变已写出的 `run-end` 与 follow-up；`curateMemory` 是记忆文件唯一写入口。

#### M5-3 M5 验收与文档

- 产出：`test/e2e/m5.e2e.spec.ts`（无 key 自跳过）、`doc/user-guide.md`（补长期记忆节）。
- 内容：同一工作流真实跑两次，断言第二次 `run-start.memoryBytes > 0` 且第二次某节点 `node-input` 含第一次的蒸馏结论；user-guide 写明机制、成本（每次 Run 结束一次策展模型调用）、文件可手工编辑/删除。
- 依赖：M5-2、M2-14。
- 验收：带 key `npm run test:spec -- e2e/m5`；无 key `npm run build` 绿。
- 判据：注入内容可从第二次 Run 的 `node-input` 事件完整重建。

## 4 文件级交付清单

| 文件 | 导出 | 消费者 |
|---|---|---|
| `src/host/index.ts` | 默认插件对象（`name`、`inject`、`Config`、`apply`） | Cordis 加载器 |
| `src/host/config.ts` | `Config`、`ConfigType` | `index.ts`、各节点实现 |
| `src/host/events.ts` | `XL_EVENTS`、`SessionEventMap` 合并 | 引擎、投影、命令、客户端折叠 |
| `src/host/projection.ts` | `XlBuildProjection`、`XlBuildView`、`RunView`、`NodeStatus` | `index.ts`、client 面板 |
| `src/host/paths.ts` | `artifactRef()`、`runDir()` | 引擎、`node-end` 事件 |
| `src/host/agents/spec.ts` | `AgentSpecSchema`、`AgentSpec` | registry、tool、mention |
| `src/host/agents/registry.ts` | `AgentRegistry`（`resolveAgent`/`listAgents`） | tool、命令、投影 `catalog.agents` |
| `src/host/agents/tool.ts` | `xl_agent_list`、`xl_agent_run` | `index.ts` 注册 |
| `src/host/agents/mention.ts` | `parseMentions`、`registerMentionStep` | `index.ts` |
| `src/host/workflow/domain.ts` | `WorkflowDocumentSchema`、`WorkflowNodeSchema`、`WorkflowEdgeSchema` 与全部 `z.infer` 类型 | host 全部 + client 图 |
| `src/host/workflow/validate.ts` | `validateDocument()` → `Issue[]` | 命令、加载器、引擎 |
| `src/host/workflow/compile.ts` | `compile()` → `Plan` | 引擎、layout |
| `src/host/workflow/expr.ts` | `evalExpr`、`validateExpr` | router、loop、validate |
| `src/host/workflow/engine.ts` | `runPlan()` | `run.ts` |
| `src/host/workflow/envelope.ts` | `renderEnvelope()` | agent/tool 节点 |
| `src/host/workflow/journal.ts` | `JournalWriter`、`replayJournal` | 引擎 |
| `src/host/workflow/memory.ts` | `readMemory`、`curateMemory` | `run.ts`、`nodes/agent.ts` |
| `src/host/workflow/nodes/*.ts` | 每种 kind 一个 `NodeImpl` | `engine.ts` 注册表 |
| `src/host/workflow/mermaid.ts` | `toMermaid` | 命令、导出动作 |
| `src/host/workflow/loaders/*.ts` | `loadDocument` | 命令、`run.ts` |
| `src/host/workflow/run.ts` | `startRun()` | 命令、subworkflow 节点 |
| `src/host/commands/workflow.ts` | `parseCommand`、命令注册 | `index.ts` |
| `src/client/index.ts` | 客户端插件对象（`inject`、`apply`） | 宿主 client 装载 |
| `src/client/mount.ts` | `mount()`、`registerUi()` | `client/index.ts`、M1-4、M3-3 |
| `src/client/locales.ts` | `NS`、`XlBuildKey`、`zh`、`en` | mount、面板组件 |
| `src/client/XlBuildIcon.tsx` | `XlBuildIcon` | `mount.ts` |
| `src/client/mention.ts` | 触发源注册 | `mount.ts` |
| `src/client/graph/*.ts` | `layoutGraph`、`renderSvg` | 面板 |
| `src/client/panel/*.tsx` | `WorkflowPanel`、`RunBoard`、`NodeDetail`、`ExportMermaid` | 面板容器 |

## 5 测试计划

| 文件 | 覆盖 | 需要 key |
|---|---|---|
| `test/config.spec.ts` | 默认值、覆盖 | 否 |
| `test/events.spec.ts` | 事件名全集、`version` | 否 |
| `test/spec.spec.ts` | AgentSpec 正负例 | 否 |
| `test/registry.spec.ts` | 扫描、热更新、坏文件隔离 | 否 |
| `test/projection.spec.ts` | 折叠、Recent 剔除、截断、容错 | 否 |
| `test/mount.client.spec.ts` | Fake 服务走真实 `apply`、注册 spec、dispose 撤回 | 否 |
| `test/locales.spec.ts` | zh/en 键集一致 | 否 |
| `test/agent-tool.spec.ts` | `startActivation` 入参、并发上限 | 否（stub） |
| `test/mention-parse.spec.ts` | 正则、双向匹配、segment 切分 | 否 |
| `test/mention-step.spec.ts` | 去重、注入、unresolved | 否 |
| `test/command-parse.spec.ts` | §6.3 语法全集 | 否 |
| `test/domain.spec.ts` | kind 判别、错放字段 | 否 |
| `test/expr.spec.ts` | 九种运算、非法表达式 | 否 |
| `test/validate.spec.ts` | V1–V17 各负例 | 否 |
| `test/compile.spec.ts` | 拓扑层、合成入边、端口收敛 | 否 |
| `test/engine.spec.ts` | 调度、并行、预算、取消 | 否（桩节点） |
| `test/nodes-*.spec.ts` | 七类节点行为 | 否（桩 provider） |
| `test/journal.spec.ts` | 续跑、unknown、不落盘 | 否 |
| `test/workflow-run.spec.ts` | 端到端进程内跑链 | 否（桩 provider） |
| `test/mermaid.spec.ts` | 两种输出快照 | 否 |
| `test/paths.spec.ts` | `fileAddressFor` 三种路径 | 否 |
| `test/loaders.spec.ts` | JSON/YAML/Python、版本迁移 | 否 |
| `test/e2e/m1.e2e.spec.ts` | 真实模型触发 `xl_agent_run` | 是（自跳过） |
| `test/memory.spec.ts` | 记忆读取注入、策展写回/保留、FIFO 串行 | 否（stub） |
| `test/e2e/m5.e2e.spec.ts` | 同一工作流两次 Run 的跨 Run 记忆注入 | 是（自跳过） |
| `test/e2e/m2.e2e.spec.ts` | 真实模型跑 3 节点链 | 是（自跳过） |

- 全部快照归 `test/snapshots/`，不放仓库顶层 `snapshots/`（该树按 `snapshots/AGENTS.md` 保留给会话驱动用例）。
- 模型可见输出的逐字断言只放在 `envelope` 与 `mention` 两个测试里，避免散落。
- 桩 provider：复用 `@deepseek-ai/dsh-agent-loop-testkit` 的既有桩，不自建第二套。

## 6 契约定稿

### 6.1 节点判别联合

`plan.md` §6.2 的表格补上公共字段后的 zod 定义，`domain.ts` 直接落这一份：

```ts
const NodeBaseSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,60}$/),
  timeoutMs: z.number().int().positive().optional(),
  maxAttempts: z.number().int().min(1).optional(),
})

const InputNode = NodeBaseSchema.extend({
  kind: z.literal('input'),
  params: z.array(z.object({
    name: z.string().min(1),
    required: z.boolean().default(true),
    default: z.unknown().optional(),
  })).default([]),
})

const AgentNode = NodeBaseSchema.extend({
  kind: z.literal('agent'),
  agent: z.string().min(1),
  task: z.string().min(1),
  context: z.union([
    z.literal('none'),
    z.object({ lastMessages: z.number().int().min(1) }),
    z.object({ from: z.literal('run-input') }),
  ]).default('none'),
  self: z.boolean().default(false),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
})

// script / tool / router / join / loop / subworkflow / output / note 同法，字段取自 plan.md §6.2
export const WorkflowNodeSchema = z.discriminatedUnion('kind', [
  InputNode, AgentNode, ScriptNode, ToolNode, RouterNode,
  JoinNode, LoopNode, SubworkflowNode, OutputNode, NoteNode,
])
```

- 公共字段只有 `id`/`timeoutMs`/`maxAttempts` 三个，其余一律落在具体 kind 上；`z.discriminatedUnion` 保证 `self` 出现在 `script` 上时直接解析失败（V16 的静态部分由 schema 兜住，V16 只再校验跨字段约束）。
- `task`/`value`/`args` 之类含模板的字段只做字符串校验，模板引用是否存在由 V13 负责。

### 6.2 `xl_agent_run` 输入

```ts
export const XlAgentRunInputSchema = z.object({
  agent: z.string().min(1).describe('AgentSpec id，与 xl_agent_list 返回的 id 一致'),
  task: z.string().min(1).describe('交给子智能体的完整任务描述；子智能体看不到当前会话历史'),
  cwd: z.string().optional().describe('相对当前工作目录解析；省略则继承会话 cwd'),
})
```

- 未知 `agent`：错误消息列出可用 id（最多 20 个，超出写「另有 N 个」），不抛异常。
- `cwd` 越界（解析后不在任何已注册工作区内）：拒绝并说明。
- 并发上限取 `Config.maxConcurrentAgentTools`（统计经该工具未结算的激活数）；超出时按 FIFO 排队新启动，`signal` 取消时整队出队。
- 工具描述必须包含三段：能力边界（`context: 'none'`，记忆为空）、何时用（可独立完成的子任务）、何时别用（一步就能做完、需要读当前会话细节）。

### 6.3 `/workflow` 的 `rawInput` 语法

```
workflow := run <id> [--input <k>=<v>]... [--self <nodeId>]
          | list
          | validate <file>
          | export <id> --mermaid
```

- `rawInput` 已去掉命令名，首 token 为子命令；未知子命令或缺参 → 返回 `plan.md` §5.4.3 的 `usage` 文本，不抛。
- `--input` 可重复；`k=v` 按**首个** `=` 切分，值原样保留（含空格），外层成对引号剥离；重复 `k` 以最后一次为准。
- `--self` 只对 `run` 有效，出现在其他子命令上即报用法错误。
- 路径参数（`validate <file>`）相对 `process.cwd()` 解析。
- 解析结果是判别联合 `{ kind: 'run', id, inputs, selfNodeId? } | { kind: 'list' } | { kind: 'validate', file } | { kind: 'export', id, format: 'mermaid' } | { kind: 'usage', text }`，`parseCommand` 单独导出以便无 host 依赖地单测。

### 6.4 事件封装

- 每个载荷 `{ version: 1, ...fields }`；`XL_EVENTS` 是唯一事件名字面量来源。
- 载荷里的 id 一律用品牌类型（`RunId`/`NodeId`/`EdgeId` 由 `dsh-brand` 定义），不用裸 `string`。
- 旧 reader 容错：投影 `apply` 对未知 `type` 与缺字段走 `parsePersisted` 风格的窄化，坏事件跳过并计数，不整帧丢弃。

### 6.5 本文补充并已写入 `plan.md` 的九处

施工图定稿与修订时补了 `plan.md` 的九处（均已写入对应小节），实现时以 `plan.md` 为准；本节只记录补充落点，便于两文档对照：

1. `Config.maxConcurrentAgentTools`（默认 `4`）：落实 §5.4.1 的「单 turn 内并行激活上限」，键位在 §5.3；它是可调项，不能退回代码常量。
2. 节点公共字段 `id` / `timeoutMs?` / `maxAttempts?` 写进 §6.2，`WorkflowNodeSchema` 据此 `extend` 同一份基础 schema；文档级 `defaults` 仍只做缺省兜底。
3. `agents/mention.ts` 导出纯函数 `parseMentions`（§5.1 树内注明），使解析可脱离 UI 与 host 单测。
4. 不生成 typert：本插件不使用 `@Remote`，前端数据通道是投影 `wire.view`（§5.1）；确有私有 RPC 时再单列任务补。
5. 文件树按 §5.1 落定，补入构建链（`tools/*`、`vitest.config.mjs`、两份 tsconfig）、`test/`、`locale/`、`icon.svg`、`doc/impl-plan.md`，以及 `envelope.ts`、`journal.ts`、`run.ts`、`nodes/simple.ts`、`ArtifactList.tsx` 与客户端挂载五件（`src/client/index.ts`、`src/client/mount.ts`、`src/client/locales.ts`、`src/client/XlBuildIcon.tsx`、`src/css-modules.d.ts`）；后两组分别是「信封唯一出口 / journal 独立 / Run 启动与节点解耦 / 简单节点合并 / 产出列表拆出」与「客户端挂载、字典、图标有唯一落点」的落点。
6. 面板宿主从右侧栏 tab 改为左侧栏成对注册（§7.2 已同步改写）：`sidebar.panellist`（list）+ `main`（keyed）共用 `PANEL_ID`，root 作用域匹配跨会话的目录/Run 看板；session 作用域的 `sidebar.right.pane.tab` 看不到独立 session 里执行的 Run。文件预览仍走 `ui-sidebar-documentpreview` / `ui-sidebar-files`（§7.3 不变）。
7. 契约修正：`SubagentStartRequest` 没有 `toolFilter` 字段（`packages/subagent/subagent/src/types.ts`；persona/工具裁剪在 harness 里已迁移到 preset 组合，配置里出现 `toolFilter` 会加载失败），AgentSpec 删除 `tools`/`skills` 字段，`readOnly` 改为只在 prompt 首块加只读声明，组合裁剪统一走 `agentPreset`（仅 `spawn` 支持）；`spec.provider` 是子激活后端、不进 `agentOptions`。§3 速查表、§5.2、§5.4.1、§5.4.3 已同步改写。
8. `xl_agent_run` 交付改异步通知：对话内路径 `delivery: 'parent'`（工具立即返回 `childId`，结算经运行时完成通知回父会话，与 `tool-subagent` 一致），Run 引擎保持 `'caller'`；`runAgentNode` 以 `delivery` 参数区分，`Config.maxConcurrentAgentTools` 语义改为「未结算激活数」，`AgentSpec.timeoutMs` 由插件保留句柄到点 `dispose()` 执行。§5.3、§5.4、§5.4.1 已同步改写。
9. 长期记忆（跨 Run 学习）定为 M5：per-workflow 有界 Markdown（`memoryDir`/`memoryMaxBytes`），读路径 `{{memory}}` 模板引用 + `context: { from: 'memory' }` 第四取值，写路径 `run-end` 后一次策展激活（`Config.memoryCurator`，全量重写、原子落盘、失败保留旧记忆、同 workflow FIFO），新事件 `xl-build/memory-updated`。§2.2（G14）、§2.3、§4、§5.1、§5.3、§5.5、§6.2、§6.8、§7.2、§8、§9 已同步。
