"""Compile a workflow script into the dsh-xl-build JSON schema.

Run it from the directory holding the bundled package:

    python py/xl_build build script.py -o out.json
    python -m xl_build build script.py -o out.json   # with py/ on PYTHONPATH
"""

from __future__ import annotations

import argparse
import json
import runpy
import sys
from pathlib import Path

# Direct-directory invocation (`python py/xl_build ...`) starts without the
# package importable; putting its parent on sys.path lets the absolute import
# below (and the compiled script's own imports) resolve. Under `-m` the path
# entry already exists.
if not __package__:
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from xl_build import XlBuildError, defined_workflows


def build(argv: list[str] | None = None) -> int:
    """Run one script and write the workflow document it defines."""
    parser = argparse.ArgumentParser(
        prog="xl_build",
        description="Compile a Python workflow definition into the dsh-xl-build JSON schema.",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    compile_parser = commands.add_parser("build", help="run one script and write its workflow document")
    compile_parser.add_argument("script", help="path to the .py file that defines one Workflow")
    compile_parser.add_argument("-o", "--out", required=True, help="path of the JSON document to write")
    compile_parser.add_argument("--name", help="workflow id to export when the script defines several")
    args = parser.parse_args(argv)

    runpy.run_path(args.script, run_name="__xl_build__")
    defined = defined_workflows()
    if args.name is not None:
        matches = [workflow for workflow in defined if workflow.id == args.name]
        if not matches:
            known = ", ".join(workflow.id for workflow in defined) or "none"
            raise XlBuildError(f"no workflow named '{args.name}' in {args.script} (defined: {known})")
        workflow = matches[0]
    elif len(defined) == 1:
        workflow = defined[0]
    elif len(defined) == 0:
        raise XlBuildError(f"{args.script} defines no Workflow; create one with Workflow(...)")
    else:
        names = ", ".join(workflow.id for workflow in defined)
        raise XlBuildError(f"{args.script} defines {len(defined)} workflows; export one with --name (defined: {names})")

    document = workflow.to_document()
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(document, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(build())
    except Exception as error:  # CLI boundary: every failure reports on stderr with exit 1
        print(f"xl_build: {error}", file=sys.stderr)
        sys.exit(1)