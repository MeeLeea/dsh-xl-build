"""Example chain for test/loaders.spec.ts: input -> agent -> output.

Compile it from the plugin root with
``python -m xl_build build test/fixtures/py-chain.py -o out.json``;
the TypeScript loaders then read the JSON document.
"""

from xl_build import Workflow

workflow = Workflow(
    id="py-chain",
    name="Python chain",
    description="Compiled from the py/xl_build example",
)
workflow.input("start", params=[{"name": "topic", "required": True}])
workflow.agent("research", agent="researcher", task="Research the topic: {{input.topic}}")
workflow.output("done", value="{{nodes.research}}")
workflow.edge("start", "research")
workflow.edge("research", "done", format="md")