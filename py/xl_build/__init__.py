"""xl_build: the Python DSL that compiles to dsh-xl-build workflow documents.

A script builds one Workflow with fluent node methods and edge calls;
``python -m xl_build build script.py -o out.json`` writes the JSON document the
TypeScript loaders parse. Field names and defaults mirror
src/host/workflow/domain.ts at schemaVersion 1; the TypeScript schema stays
the single validator, so this package only checks what it needs to build a
self-consistent document shape.
"""

from __future__ import annotations

from typing import Any, Optional, Sequence

SCHEMA_VERSION = 1

_DEFINED: list["Workflow"] = []


class XlBuildError(Exception):
    """A definition the DSL cannot turn into a self-consistent document."""


def defined_workflows() -> list["Workflow"]:
    """Every Workflow registered by the script executed in this process."""
    return list(_DEFINED)


class Workflow:
    """One workflow document under construction; every method returns self."""

    def __init__(
        self,
        id: str,
        name: str,
        description: Optional[str] = None,
        entry: Optional[str] = None,
        defaults: Optional[dict[str, Any]] = None,
        outputs: Optional[dict[str, str]] = None,
    ) -> None:
        if not isinstance(id, str) or len(id) == 0:
            raise XlBuildError("workflow id must be a non-empty string")
        if not isinstance(name, str) or len(name) == 0:
            raise XlBuildError("workflow name must be a non-empty string")
        self.id = id
        self._doc: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "id": id,
            "name": name,
            "nodes": [],
            "edges": [],
            "outputs": dict(outputs or {}),
        }
        if description is not None:
            self._doc["description"] = description
        if defaults is not None:
            self._doc["defaults"] = dict(defaults)
        if entry is not None:
            self._doc["entry"] = entry
        _DEFINED.append(self)

    def to_document(self) -> dict[str, Any]:
        """The finished JSON document, deriving entry from the first node."""
        doc = self._doc
        if "entry" not in doc:
            if len(doc["nodes"]) == 0:
                raise XlBuildError(f"workflow '{doc["id"]}' defines no nodes")
            doc["entry"] = doc["nodes"][0]["id"]
        return doc

    def _base(
        self,
        id: str,
        timeout_ms: Optional[int],
        max_attempts: Optional[int],
    ) -> dict[str, Any]:
        if not isinstance(id, str) or len(id) == 0:
            raise XlBuildError("node id must be a non-empty string")
        node: dict[str, Any] = {"id": id}
        if timeout_ms is not None:
            node["timeoutMs"] = timeout_ms
        if max_attempts is not None:
            node["maxAttempts"] = max_attempts
        return node

    def _add(self, node: dict[str, Any]) -> "Workflow":
        self._doc["nodes"].append(node)
        return self

    def input(
        self,
        id: str,
        params: Optional[Sequence[dict[str, Any]]] = None,
        timeout_ms: Optional[int] = None,
        max_attempts: Optional[int] = None,
    ) -> "Workflow":
        """Add an input node; params is a list of {name, required?, default?} dicts."""
        node = self._base(id, timeout_ms, max_attempts)
        node["kind"] = "input"
        if params is not None:
            node["params"] = [dict(param) for param in params]
        return self._add(node)

    def agent(
        self,
        id: str,
        agent: str,
        task: str,
        context: Any = "none",
        self_: bool = False,
        output_schema: Optional[dict[str, Any]] = None,
        timeout_ms: Optional[int] = None,
        max_attempts: Optional[int] = None,
    ) -> "Workflow":
        """Add an agent node; context is "none", {"lastMessages": n}, or {"from": ...}."""
        node = self._base(id, timeout_ms, max_attempts)
        node["kind"] = "agent"
        node["agent"] = agent
        node["task"] = task
        node["context"] = context
        if self_:
            node["self"] = True
        if output_schema is not None:
            node["outputSchema"] = output_schema
        return self._add(node)

    def script(
        self,
        id: str,
        command: Optional[str] = None,
        script: Optional[str] = None,
        runtime: str = "shell",
        args: Optional[Sequence[str]] = None,
        stdin: str = "none",
        timeout_ms: Optional[int] = None,
        max_attempts: Optional[int] = None,
    ) -> "Workflow":
        """Add a script node; pass exactly one of command (shell) or script (ptc)."""
        node = self._base(id, timeout_ms, max_attempts)
        node["kind"] = "script"
        node["runtime"] = runtime
        if command is not None:
            node["command"] = command
        if script is not None:
            node["script"] = script
        if args is not None:
            node["args"] = list(args)
        if stdin != "none":
            node["stdin"] = stdin
        return self._add(node)

    def tool(
        self,
        id: str,
        tool: str,
        args: Optional[dict[str, str]] = None,
        timeout_ms: Optional[int] = None,
        max_attempts: Optional[int] = None,
    ) -> "Workflow":
        """Add a tool node; args maps tool argument names to templates."""
        node = self._base(id, timeout_ms, max_attempts)
        node["kind"] = "tool"
        node["tool"] = tool
        if args is not None:
            node["args"] = dict(args)
        return self._add(node)

    def router(
        self,
        id: str,
        branches: Optional[Sequence[tuple[str, str]]] = None,
        else_: Optional[str] = None,
        timeout_ms: Optional[int] = None,
        max_attempts: Optional[int] = None,
    ) -> "Workflow":
        """Add a router node; branches is a sequence of (jsonlogic, target id) pairs."""
        node = self._base(id, timeout_ms, max_attempts)
        node["kind"] = "router"
        if branches is not None:
            node["branches"] = [{"when": when, "to": to} for when, to in branches]
        if else_ is not None:
            node["else"] = else_
        return self._add(node)

    def join(
        self,
        id: str,
        strategy: str = "all",
        quorum: Optional[int] = None,
        fail_fast: bool = False,
        timeout_ms: Optional[int] = None,
        max_attempts: Optional[int] = None,
    ) -> "Workflow":
        """Add a join node; strategy is all, any, or quorum (with quorum=n)."""
        node = self._base(id, timeout_ms, max_attempts)
        node["kind"] = "join"
        node["strategy"] = strategy
        if quorum is not None:
            node["quorum"] = quorum
        if fail_fast:
            node["failFast"] = True
        return self._add(node)

    def loop(
        self,
        id: str,
        body: str,
        until: str,
        max_iters: int,
        on_max_iters: str = "fail",
        carry: Optional[Sequence[str]] = None,
        emit: Optional[Sequence[str]] = None,
        timeout_ms: Optional[int] = None,
        max_attempts: Optional[int] = None,
    ) -> "Workflow":
        """Add a loop node over body; until is a JSONLogic expression on edges."""
        node = self._base(id, timeout_ms, max_attempts)
        node["kind"] = "loop"
        node["body"] = body
        node["until"] = {"expr": until}
        node["maxIters"] = max_iters
        if on_max_iters != "fail":
            node["onMaxIters"] = on_max_iters
        if carry is not None:
            node["carry"] = list(carry)
        if emit is not None:
            node["emit"] = list(emit)
        return self._add(node)

    def subworkflow(
        self,
        id: str,
        workflow: str,
        inputs: Optional[dict[str, str]] = None,
        timeout_ms: Optional[int] = None,
        max_attempts: Optional[int] = None,
    ) -> "Workflow":
        """Add a subworkflow node referencing another saved workflow id."""
        node = self._base(id, timeout_ms, max_attempts)
        node["kind"] = "subworkflow"
        node["workflow"] = workflow
        if inputs is not None:
            node["inputs"] = dict(inputs)
        return self._add(node)

    def output(
        self,
        id: str,
        value: str,
        timeout_ms: Optional[int] = None,
        max_attempts: Optional[int] = None,
    ) -> "Workflow":
        """Add an output node; value is a template over input, nodes, edges, memory."""
        node = self._base(id, timeout_ms, max_attempts)
        node["kind"] = "output"
        node["value"] = value
        return self._add(node)

    def note(
        self,
        id: str,
        text: str,
        timeout_ms: Optional[int] = None,
        max_attempts: Optional[int] = None,
    ) -> "Workflow":
        """Add a note node; notes render as graph comments only."""
        node = self._base(id, timeout_ms, max_attempts)
        node["kind"] = "note"
        node["text"] = text
        return self._add(node)

    def edge(
        self,
        from_: str,
        to: str,
        kind: str = "flow",
        format: str = "text",
        id: Optional[str] = None,
        label: Optional[str] = None,
        select: Optional[str] = None,
        template: Optional[str] = None,
        condition: Optional[str] = None,
        max_bytes: Optional[int] = None,
    ) -> "Workflow":
        """Add an edge; kind is flow, branch, fan-out, fan-in, loop-back, or error."""
        used = {edge["id"] for edge in self._doc["edges"]}
        if id is None:
            base = f"{from_}-to-{to}"
            id = base
            counter = 2
            while id in used:
                id = f"{base}-{counter}"
                counter += 1
        elif id in used:
            raise XlBuildError(f"duplicate edge id '{id}' in workflow '{self._doc["id"]}'")
        edge: dict[str, Any] = {"id": id, "from": from_, "to": to, "kind": kind}
        if format != "text":
            edge["format"] = format
        if label is not None:
            edge["label"] = label
        if select is not None:
            edge["select"] = select
        if template is not None:
            edge["template"] = template
        if condition is not None:
            edge["condition"] = condition
        if max_bytes is not None:
            edge["maxBytes"] = max_bytes
        self._doc["edges"].append(edge)
        return self