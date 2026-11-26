# cmodel-agents:Skill-sc_model 拆分计划

将 `.agents/skills/Skill-sc_model`(芯粒 SystemC CModel 开发技能)拆分为本包 `agents/` 目录下的内置子智能体定义。本文是拆分依据:源功能盘点、两条关键适配、六个 agent 的字段与继承映射、不迁入的部分。落地文件以本文为准;写入 `agents/` 后需重启 `dsh` 生效(包内定义不热重载,见 [../agents/README.md](../agents/README.md))。

## 1 源 skill 功能盘点

| 源内容 | SKILL.md 行号(Scripts/templates 为文件) | 性质 |
| --- | --- | --- |
| 交互规则 + 确认网关 | L11-16;Step 1(167-182)、Step 3-5(210-260)、Step 6(262-275)、编译失败(295-311)、Step 8-9(313-345) | 流程编排 |
| 不可违背建模约束:端口与接口 | L18-26 | 领域知识 |
| 不可违背建模约束:构造与配置 | L28-44 | 领域知识 |
| 不可违背建模约束:TLM 日志(SocketTrace) | L46-70 | 领域知识 |
| 不可违背建模约束:激励文件 | L72-93 | 领域知识 |
| 不可违背建模约束:功耗报告 | L95-102 | 领域知识 |
| 不可违背建模约束:测试与构建(Simulator TB) | L104-121 | 领域知识 |
| 项目目录结构 + 脚手架/构建运行命令 | L123-163 | 目录约定 |
| 9-step Workflow + 编译错误处理 | L165-368 | 流程编排 |
| 冲突处理 | L370-376 | 评审知识 |
| QA 清单(10 条) | L378-391 | 评审知识 |
| scaffold.sh / build.sh / run.sh / pack.sh | Scripts/*.sh(约 180 行) | 自动化逻辑 |
| chiplet.h / Simulator.h / Simulator.cpp / performance.json / pinmap.json / stimulus.csv | templates/(约 330 行) | 代码资产 |
| demo/ 预置构建环境(CMake + SystemC 2.3.3 + spdlog + nlohmann_json) | demo/ | 运行时资源 |

## 2 两条关键适配

源 skill 面向单会话交互;本包的子智能体是无交互的子激活,workflow 引擎也没有 pause/human 节点。两条语义映射如下。

### 2.1 ask_human → 结构化 ask 输出 + 主会话中转

宿主禁止子激活直接询问用户(委派调用方的确认请求被拒绝),并要求把未决问题写入子 agent 的最终结果。因此 `ask_human` 改为:承担确认责任的 agent 声明下方 `outputSchema`,输出 `status: "ask"` 时携带 `prompt` 与 `choices`。只有运行时根(主会话)能真正向用户提问;流转规则:

1. 子 agent 输出 `status: "ask"` 后结束本轮激活;父会话收到该结果。
2. 主会话向用户转达 `ask.prompt` 与选项;用户选择 `cancel`(或返回 `cancelled: true`)时,orchestrator 停止后续派发。
3. 用户答复后,主会话以 `send_message` 恢复原子激活(或以补充输入重新派发该步骤),被恢复的激活按新一次激活计时(`timeoutMs`)。
4. `cmodel-orchestrator` 自身也是子激活:它的 ask 同样只能上报给主会话,由主会话中转;它不得声称「等待用户」而结束。

启用该封装的角色:`cmodel-orchestrator`(Step 1/6/8/9)、`cmodel-designer`(need_driver)、`cmodel-implementer`(Step 3/4/5)、`cmodel-builder`(编译失败不可修正)。`cmodel-reviewer` 是终局核验、不产生 ask,用专用 verdict schema(§3.5);`cmodel-packer` 不产生 ask。

```jsonc
{
  "type": "object",
  "required": ["status"],
  "properties": {
    "status": { "enum": ["done", "ask", "blocked"] },
    "ask": {
      "type": "object",
      "required": ["prompt", "choices"],
      "properties": {
        "prompt": { "type": "string" },
        "choices": { "type": "array", "items": { "type": "object", "required": ["id", "label"], "properties": { "id": { "type": "string" }, "label": { "type": "string" } } } }
      }
    },
    "result": { "type": ["string", "object"] }
  }
}
```

### 2.2 bash 脚本 → prompt 内嵌逻辑 + resourcesRoot 前置

`Scripts/*.sh` 是 bash 脚本;`standard` preset 的 shell 在 win32 上是 pwsh,不能依赖 bash 可用。四个脚本的逻辑改写为 prompt 指令(fs 读模板 → 名称替换 → 写目标),执行不依赖脚本文件存在。`demo/` 预置环境含 vendored 依赖树,不复制进本包,作为外部前置在 README 与 prompt 中标注。任务输入必填 `resourcesRoot`(指向含 `templates/` 与 `demo/` 的 skill 目录绝对路径),由用户经 orchestrator 传入每个子 agent;prompt 不硬编码绝对路径。路径缺失或模板读取失败时,implementer/builder 立即失败上报,不得猜测路径或使用默认位置。

## 3 六个 agent

命名与现有内置 `rtl-designer` / `rtl-verification` 对齐为 `cmodel-*` 系列;prompt 风格对齐 `agents/rtl-designer.yml`(中文分节、字段注释);统一 `provider: spawn`、`agentPreset: standard`。

执行路径与 readOnly 语义:编排走 `xl_agent_run`(与内置 `manager.yml` 一致);该路径上 `readOnly` 仅表现为角色提示词首部的只读前缀,**不裁剪工具**;真正的工具裁剪只发生在 `xl-cmodel-*` preset 组合路径(`agents/README.md` 映射表)。因此下表 `readOnly` 列的语义是「该角色不应写文件或执行改状态命令」的角色约束 + preset 路径的强制开关;需要硬强制时经 preset 路径委派。`xl_agent_run` / `xl_agent_list` 是全局注册工具,子激活可见,orchestrator 的派发能力依赖这一点。

### 3.1 `cmodel-orchestrator`(流程编排)

| 项 | 值 |
| --- | --- |
| `readOnly` | `true` |
| `timeoutMs` | `3600000`(覆盖五级流水线;ask 结算后由主会话恢复,恢复按新一次激活计时) |
| `outputSchema` | §2.1 封装(编排报告放 `result`;Step 1/6/8/9 的确认场景经 `ask` 上报) |

继承:交互规则(L11-16,仅在信息不足时请求确认、cancel 即停)、Step 1 范围确认策略(L167-182:芯粒名/任务类型/模型类型/交付目录四要素不完整则输出 ask)、Step 6 设计审阅(L262-275:汇总 designer 设计与 reviewer 核对结果展示给用户;核对本身归 reviewer,展示归 orchestrator)、Step 8 交付摘要(L313-326:改动摘要、验证结果、使用方法、遗留风险;git 提交由主会话执行,orchestrator 仅转达 `request_commit` 选择)、Step 9 打包询问与 packer 派发(L328-345)、冲突处理规则(L370-376)、designer → implementer → builder → reviewer 流水线派发、§2.1 的 ask 中转与恢复职责(收到用户答复后继续派发;cancel 即停)。

### 3.2 `cmodel-designer`(设计)

| 项 | 值 |
| --- | --- |
| `readOnly` | `true` |
| `timeoutMs` | `900000` |
| `outputSchema` | §2.1 封装(设计文档 + 待确认清单放 `result`;`need_driver` 推断不了经 `ask` 上报) |

继承:Step 2 只读检查(L186:`inc/`、`src/`、`json_config/`、`CMakeLists.txt`、已有依赖)、端口与接口约束(L20-26:数字信号 TLM simple socket,输入 target / 输出 initiator;模拟与 vdd/gnd/clk 统一 `sc_in<double>`;芯片间模拟信号 `sc_signal<double>` 连接)、构造与配置约束(L28-44:构造函数 `(sc_module_name name, const std::string& config_path[, csv_file])` 且参数名固定 `config_path`、`{Name}.performance` 必填字段 `name/category/type/area/power/need_driver`、`need_driver` 为字符串 `"TRUE"`/`"FALSE"`、`frequence` 拼写、必须实现 `end_of_elaboration()`、新依赖先查现有项目)、need_driver 推断-否则-ask(L190-201)、TLM 日志设计要求(L203)、CMakeLists 要求(L206:`find_package(SystemCLanguage)`、spdlog、Boost filesystem、nlohmann_json)。

### 3.3 `cmodel-implementer`(代码落地,继承份额最大)

| 项 | 值 |
| --- | --- |
| `readOnly` | `false`(写生成文件,需要 fs 写) |
| `timeoutMs` | `1800000` |
| `outputSchema` | §2.1 封装(文件清单放 `result`;Step 3/4/5 的确认场景经 `ask` 上报) |

继承(生成文件**直接写入 `demo/` 子目录**,与 scaffold.sh 落位一致,文件落位归本角色,见 §3.4):

- 脚手架落位映射:templates/chiplet.h → `demo/inc/<CHIPLET>.h`;templates/performance.json → `demo/json_config/<CHIPLET>.performance`;templates/pinmap.json → `demo/pinmap/<CHIPLET>.pinmap`;templates/Simulator.h → `demo/inc/Simulator.h`;templates/Simulator.cpp → `demo/src/Simulator.cpp`;templates/stimulus.csv → `demo/csv/<CHIPLET>.csv`(仅 `need_driver != "FALSE"`)。
- 占位符替换按模板区分:chiplet.h 与 stimulus.csv 替换 `CHIPLET`;performance.json 与 pinmap.json 替换 `CHIPLET_NAME`;Simulator.h 与 Simulator.cpp 替换 `CHIPLET` 及复合词 `CHIPLET.performance`、`CHIPLET.csv`、`CHIPLET.pinmap`(scaffold.sh L39-68 为准)。
- TLM 日志(L46-70):SocketTrace 结构体、`BUFFER_THRESHOLD = 8192`、`wavefile/{ModuleName}_target_socket_0_wavefile.log` 与 `_initiator_socket_0_wavefile.log` 命名、时间戳 + 十六进制 payload 格式、达到阈值刷新且析构最终刷新。
- 激励文件(L72-93):默认分帧二维格式 `pixel[0..N-1],duration_ns`,N = rows × columns;备选一维格式 `duration(ns), value`;注释必须说明维度、单位、含义。
- 功耗报告(L95-102):除虚拟功能模型必须实现 `report_power()`、输出格式固定 `{name}: dynamic_power: {power}`、析构函数资源刷新后调用。
- Simulator TB(L104-121):`Simulator.h` 完全自包含含双构造函数、`sc_signal<double>` 模拟信号连接、`clock_generator()` 10MHz 时钟线程、`write_configuration()` 配置写入线程、`data_b_transport()` 数据接收回调、内部芯粒实例;`Simulator.cpp` 为 `sc_main` 硬编码模板仅改类名;`.h` 放 `inc/`、实现放 `src/`。
- CMakeLists:demo/ 已预置不动;目标项目无预置 CMakeLists 时由本角色按 designer 的要求(L206)生成。
- Step 3 非标准激励格式 ask 策略(L210-224)、Step 4 功耗公式推断-否则-ask(L227-244)、Step 5 新依赖确认-否则-复用(L246-260)。

### 3.4 `cmodel-builder`(构建运行)

| 项 | 值 |
| --- | --- |
| `readOnly` | `false`(执行构建与运行,需要平台 shell;自动修正时需 fs 编辑) |
| `timeoutMs` | `1800000` |
| `outputSchema` | §2.1 封装(构建/运行报告放 `result`;不可自动修正的失败经 `ask` 上报) |

继承(文件落位已归 implementer,本角色不再拷贝部署,只确认文件就位后构建):

- 构建逻辑(build.sh 完整语义):删除旧 `demo/build/` 后重建;探测 SystemC(`SYSTEMC_HOME` 环境变量、`has_systemc`、候选目录逐一尝试);Windows 优先 Ninja 生成器,其余按平台选 MinGW Makefiles / Unix Makefiles;`cmake -DCMAKE_BUILD_TYPE=Release` 配置;`cmake --build --parallel` 编译(等价 `make -j` 但不假设 make 存在)。
- 运行逻辑(run.sh 完整语义):执行 `demo/build/` 下的 RISCV_TLM,Windows 优先 `RISCV_TLM.exe`;检查 stdout 与退出码,`return 0` 为成功(L293-296)。
- 编译错误自动修正循环(L295-309):头文件缺失、命名不一致、构造函数参数不匹配等自动修正后重建;SystemC 环境、依赖缺失、模型算法逻辑不可自动修正时经 `ask` 上报具体错误。

### 3.5 `cmodel-reviewer`(评审)

| 项 | 值 |
| --- | --- |
| `readOnly` | `true` |
| `timeoutMs` | `600000` |
| `outputSchema` | `{ pass: boolean, violations: string[] }`(终局核验,不产生 ask,故不用 §2.1 封装) |

继承:QA 清单 10 条逐项核对(L378-391:数字信号 TLM socket / 模拟端口、Simulator 模拟信号连接、`config_path` 参数名、`end_of_elaboration()`、JSON 加载与 `need_driver` 字符串、SocketTrace 日志、日志文件命名与 `wavefile/` 位置、析构刷新与 `report_power()` 输出格式、Simulator.h 自包含与 Simulator.cpp 入口、无未经确认的新增依赖)、冲突处理核对(L370-376:`frequence` 拼写、`need_driver` 不可猜测、JSON 参数与构造函数要求不互斥、虚拟模型 `report_power()` 豁免)。核对结果由 orchestrator 汇入 Step 6 审阅材料。

### 3.6 `cmodel-packer`(打包分发)

| 项 | 值 |
| --- | --- |
| `readOnly` | `false`(写 `pack/` 目录) |
| `timeoutMs` | `600000` |
| `outputSchema` | 不启用(正文输出打包文件清单,不产生 ask) |

继承:Step 9 打包(L328-345):`pack/<CHIPLET_NAME>/` 结构硬编码、来源映射(`demo/inc/*` → `pack/<NAME>/inc/*` 整体拷贝、`demo/src/*` 同理、`demo/json_config/<NAME>.performance` → `pack/<NAME>/<NAME>.performance`、`demo/pinmap/<NAME>.pinmap` → `pack/<NAME>/<NAME>.pinmap`、`demo/csv/<NAME>.csv` → `pack/<NAME>/<NAME>.csv` 仅 `need_driver != "FALSE"` 时包含)。pinmap 行以 `Scripts/pack.sh:45` 为准——SKILL.md 自己的映射表(L361-368)漏了它,以脚本实际行为继承。`--no-driver` 参数处理同脚本。

## 4 不迁入的部分(有意保留)

- **demo/ 预置环境本体**:含 vendored 依赖树,体积大且与 skill 目录绑定;builder 的 prompt 写明目录约定(`build/` 每次清空重建、`spdlog/`、`third_party/`、`parse-deps/` 不动),路径由任务输入 `resourcesRoot` 提供(§2.2),缺失即失败。
- **templates/**:留在 skill 目录随 `resourcesRoot` 提供;不复制进插件包,避免与 skill 目录双源维护。
- **「适用范围」段(L7-9)**:由各 agent 的 `description` 一行承担,`xl_agent_list` 只返回 description。
- **Scripts/*.sh 文件本体**:逻辑已内嵌 prompt(§2.2),运行时不要求 bash 与脚本存在。
- **git 提交动作**:由主会话承担;orchestrator 只转达 `request_commit` 选择(§3.1)。

## 5 落地清单

1. 按 §3 写 6 个 yml 到 `agents/`(与内置 `rtl-designer.yml` 同风格,字段注释齐备);承担 ask 责任的四个(orchestrator/designer/implementer/builder)启用 §2.1 `outputSchema`。
2. 补全 `agents/README.md` 内置清单:现缺 `architect`、`rtl-designer`、`rtl-verification`,新增 `cmodel-*` 六项。
3. `resourcesRoot` 约定写入每个承担文件操作的 prompt(orchestrator/implementer/builder/packer):调用方传 skill 目录绝对路径,agent 用 fs 工具读模板、写产物;缺失即失败(§2.2)。
4. 验证:`xl_agent_list` 应列出 6 个新 id 且 `invalid` 为空;`@cmodel-orchestrator` 提一个最小任务,走通派发链并验证一次完整的 ask 中转(子 agent 输出 ask → 主会话转用户 → `send_message` 恢复续聊)。

## 6 备选

`cmodel-packer` 可并入 `cmodel-builder`(5 个 agent);不采用——Step 9 是独立可选交付步骤,打包映射表硬编码且与构建职责无关,独立定义与源 skill 步骤一一对应。
