"""xl-build-pipeline 的 Python DSL 源码。

编译成插件可读的 JSON（插件只扫描 .json/.yml/.yaml，不扫描 .py）：

    python py/xl_build build workflow/xl-build-pipeline.py -o workflow/xl-build-pipeline.py.json

拓扑：input(goal) → manager 出计划 → worker + scripting-engineer 并行实现
    → join 汇总 → reviewer 只读复核 → output。
"""

from xl_build import Workflow

PLAN_TASK = """这是 workflow 引擎的一次节点调用：只产出执行计划，不要调用 xl_agent_run 派发子任务，也不要修改任何文件。
目标：{{input.goal}}
输出一份有序子任务清单：每项写明负责角色（worker / scripting-engineer）、目标文件、范围边界、验收方式，并标出哪些项可以并行。
"""

IMPLEMENT_TASK = """完成计划中指派给 worker 的全部子任务：保持最小正确变更，跑一个聚焦检查证明结果，报告改动文件与实际检查输出。
计划：
{{nodes.plan}}
"""

AUTOMATE_TASK = """为计划中适合自动化的部分写一个非交互脚本并实际运行验证：不引入新依赖，报告脚本路径、调用方式与实际输出。
计划：
{{nodes.plan}}
"""

REVIEW_TASK = """只读复核以下两路产物对应的仓库变更：正确性、边界与资源清理、与计划的一致性。按严重度列出缺陷（file:line + 具体修复）；没有缺陷就明确说明，不要编造 nitpick。
计划：
{{nodes.plan}}
实现报告：
{{nodes.implement}}
自动化脚本报告：
{{nodes.automate}}
"""

DONE_VALUE = """## 计划
{{nodes.plan}}
## 实现报告
{{nodes.implement}}
## 自动化脚本
{{nodes.automate}}
## 评审结论
{{nodes.review}}
"""

workflow = Workflow(
    id="xl-build-pipeline",
    name="XL build pipeline",
    description="manager 拆解目标为执行计划，worker 与 scripting-engineer 并行实现，reviewer 只读复核后汇总输出。",
    entry="start",
    outputs={"report": "{{nodes.done}}"},
)

workflow.input("start", params=[{"name": "goal", "required": True}])
workflow.agent("plan", agent="manager", task=PLAN_TASK)
workflow.agent("implement", agent="worker", task=IMPLEMENT_TASK)
workflow.agent("automate", agent="scripting-engineer", task=AUTOMATE_TASK)
workflow.join("merge", strategy="all")
workflow.agent("review", agent="reviewer", task=REVIEW_TASK)
workflow.output("done", value=DONE_VALUE)

workflow.edge("start", "plan", kind="flow")
workflow.edge("plan", "implement", kind="fan-out")
workflow.edge("plan", "automate", kind="fan-out")
workflow.edge("implement", "merge", kind="fan-in")
workflow.edge("automate", "merge", kind="fan-in")
workflow.edge("merge", "review", kind="flow")
workflow.edge("review", "done", kind="flow")
