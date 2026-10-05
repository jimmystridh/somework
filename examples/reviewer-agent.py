#!/usr/bin/env python3
"""Demo reviewer: one task JSON line on stdin, JSON lines on stdout (progress / result / failure).

code.review@1 only takes a repository name and approves it. code.review@2 reads the code it is given
(`files` or `text`) and applies a few static checks. It is a stand-in for a real agent, not a real reviewer."""
import json
import re
import sys

job = json.loads(sys.stdin.readline())
task_input = job["task"]["input"]
version = job["capability"]["version"]


def emit(**message):
    print(json.dumps(message), flush=True)


if version == "1":
    emit(type="result", result={"verdict": "approve", "summary": f"no automated checks for {task_input.get('repository')}"})
    sys.exit(0)

sources = [(f["name"], f["content"]) for f in task_input.get("files", [])]
if "text" in task_input:
    sources.append(("input.txt", task_input["text"]))
if not sources:
    emit(type="failure", code="nothing_to_review", message="v2 needs `files` or `text`; `repository` alone is only a label")
    sys.exit(0)

findings = []


def add(name, line, severity, message):
    findings.append({"file": name, "line": line, "severity": severity, "message": message})


for name, content in sources:
    emit(type="progress", message=f"reviewing {name}")
    lines = content.splitlines()
    if lines and lines[0].startswith("#!") and ("sh" in lines[0]) and not re.search(r"^\s*set\s+-[a-z]*[eu]", content, re.M):
        add(name, 1, "medium", "shell script without `set -e`/`set -u`: failures and unset variables are ignored")
    for number, line in enumerate(lines, 1):
        code = line.split("#", 1)[0]
        if re.search(r"\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+(/|\$[A-Za-z_{]|~)", code):
            add(name, number, "high", "recursive delete on a variable or root-level path; an empty variable can delete the wrong tree")
        if re.search(r"(curl|wget)[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b", code):
            add(name, number, "high", "downloads and executes remote code without verification")
        if re.search(r"\bsudo\b", code):
            add(name, number, "medium", "uses sudo: the script silently depends on elevated privileges")
        if re.search(r"\b(rm|mv|cp)\b[^|;&]*\$[A-Za-z_][A-Za-z0-9_]*(?![\"A-Za-z0-9_}])", code) and '"$' not in code:
            add(name, number, "low", "unquoted variable in a file command: breaks on spaces and globbing")

severity_rank = {"high": 3, "medium": 2, "low": 1}
worst = max((severity_rank[f["severity"]] for f in findings), default=0)
verdict = {3: "reject", 2: "needs_changes", 1: "needs_changes", 0: "approve"}[worst]
emit(type="result", result={"verdict": verdict, "summary": f"{len(findings)} finding(s) in {len(sources)} source(s)", "findings": findings})
