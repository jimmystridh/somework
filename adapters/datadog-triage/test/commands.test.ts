import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bashApproval, checkCommand, checkFileTool, pythonProblem, workspaceRelative } from "../src/commands.ts";

const allowed = [
	"python3 -c 'import json; print(json.load(open(\"data/logs_search-1.json\"))[\"count\"])'",
	"python3 -c \"import json,collections; d=json.load(open('data/logs_search-1.json')); print(collections.Counter(l['status'] for l in d['lines']))\"",
	"python3 scratch/aggregate.py data/logs_search-1.json",
	"python3 -B scratch/aggregate.py data/metrics_query-1.json --top 5",
	"python3 -m json.tool data/events_search-1.json",
	"jq '.lines | length' data/logs_search-1.json",
	"jq -r '.lines[] | select(.status==\"error\") | .message' data/logs_search-1.json | sort | uniq -c | sort -rn | head -20",
	"jq --arg s error '.lines | map(select(.status == $s)) | length' data/logs_search-1.json",
	"awk -F'|' '{print $1}' data/x.txt",
	"awk '/error/ {n++} END {print n}' data/x.txt",
	"sed -n '10,40p' data/x.txt",
	"sed 's/token=[a-z]*/token=X/g' data/x.txt",
	"sort -k2 -n data/x.txt | uniq -c | head -5",
	"grep -c error data/x.txt",
	"grep -rn 'timeout' data/",
	"cat data/x.json | wc -l",
	"ls -la data/",
	"ls",
	"tail -n 50 data/x.txt",
	"cut -d, -f1,3 data/x.csv | sort | uniq",
	"echo '1+2*3' | bc -l",
	"date -u +%s",
	"date -u -d '2026-10-06T09:00:00Z' +%s",
	"mkdir -p scratch/out",
	"mkdir -p data",
	"python3 -c 'print(1)' > scratch/out.txt",
	"python3 -c 'print(1)' >> scratch/out.txt 2>&1",
	"python3 -c 'print(1)' 2>/dev/null",
	"cat data/x.json > /dev/null",
	"rm scratch/old.json",
	"rm -rf scratch/out",
	"mv scratch/a.json scratch/b.json",
	"cp data/x.json scratch/x.json",
	"touch scratch/note.txt",
	"echo hello && ls data/ ; pwd",
	"tr a-z A-Z < data/x.txt",
	"wc -l < data/x.txt",
	"head -5 data/x.json\nwc -c data/x.json",
	"python3 -c 'import statistics, datetime, re, math, csv, collections, itertools; print(statistics.mean([1,2]))'",
];

const refused: [string, RegExp][] = [
	["curl https://example.com", /no network/],
	["wget -qO- http://x", /no network/],
	["ssh host ls", /no network/],
	["git log", /no network|no git/],
	["pip install requests", /package manager/],
	["npm i left-pad", /package manager/],
	["apt-get install curl", /package manager/],
	["bash -c 'ls'", /not available|no other shell/],
	["sh script.sh", /not available|no other shell/],
	["node -e 1", /not available/],
	["env", /not available/],
	["find . -name x", /not available/],
	["xargs rm", /not available/],
	["tee out.txt", /not available/],
	["sudo ls", /not available/],
	["nohup ls", /not available/],
	["timeout 5 ls", /not available/],
	["chmod +x x", /not one of the allowed/],
	["/bin/ls", /by name/],
	["./scratch/run", /by name/],
	["FOO=1 ls", /environment variables/],
	["python3", /needs -c/],
	["python3 -", /standard input/],
	["python3 script.py", /scratch\//],
	["python3 /tmp/x.py", /scratch\//],
	["python3 ../x.py", /scratch\//],
	["python3 -m http.server", /json\.tool/],
	["python3 -m pip install x", /json\.tool/],
	["python3 -c 'import socket; socket.create_connection((\"1.1.1.1\", 80))'", /socket/],
	["python3 -c 'import urllib.request'", /urllib/],
	["python3 -c 'from urllib import request'", /urllib/],
	["python3 -c 'import json, subprocess'", /subprocess/],
	["python3 -c 'import os; os.system(\"id\")'", /os\.system/],
	["python3 -c 'import os; os.remove(\"data/x\")'", /os\.remove/],
	["python3 -c '__import__(\"socket\")'", /__import__/],
	["python3 -c 'exec(open(\"x\").read())'", /exec/],
	["python3 -c 'import shutil'", /shutil/],
	["python3 -c 'print(1)' /etc/passwd", /outside/],
	["python3 scratch/a.py ../secrets", /outside/],
	["jq . /etc/passwd", /inside the workspace/],
	["jq -f prog.jq data/x.json", /not allowed/],
	["jq --rawfile a /etc/passwd . data/x.json", /not allowed/],
	["cat /etc/passwd", /inside the workspace/],
	["cat ../other/x", /inside the workspace/],
	["cat ~/x", /inside the workspace/],
	["ls /", /inside the workspace/],
	["head /proc/self/environ", /inside the workspace/],
	["grep -f /etc/passwd data/x", /-f is not allowed/],
	["grep root /etc/passwd", /inside the workspace/],
	["sed -i s/a/b/ data/x", /standard output/],
	["sed -n 'w out.txt' data/x", /sed programs are limited/],
	["sed 's/a/b/w out.txt' data/x", /sed programs are limited/],
	["sed -e 'e' data/x", /sed programs are limited/],
	["sed 's/a/b/e' data/x", /sed programs are limited/],
	["awk 'BEGIN { system(\"id\") }'", /writes, pipes or runs/],
	["awk '{print > \"out.txt\"}' data/x", /writes, pipes or runs/],
	["awk '{print | \"sh\"}' data/x", /writes, pipes or runs/],
	["awk 'BEGIN { \"date\" | getline d }'", /writes, pipes or runs/],
	["awk -f prog.awk data/x", /not allowed/],
	["sort -o out.txt data/x", /standard output/],
	["sort --output=out.txt data/x", /standard output/],
	["uniq data/x out.txt", /at most one/],
	["tail -f data/x", /forever/],
	["date -s '2026-01-01'", /clock/],
	["date 100612002026", /FORMAT/],
	["rm data", /inside data\/ and scratch\//],
	["rm -rf /", /inside data\/ and scratch\//],
	["rm -rf data/../..", /inside data\/ and scratch\//],
	["rm x.txt", /inside data\/ and scratch\//],
	["mv data/a /tmp/a", /inside data\/ and scratch\//],
	["mv x.txt data/x.txt", /inside data\/ and scratch\//],
	["cp /etc/passwd scratch/p", /inside the workspace/],
	["cp data/x.json /tmp/x.json", /into data\/ or scratch\//],
	["mkdir other", /inside data\/ and scratch\//],
	["echo x > out.txt", /inside data\/ and scratch\//],
	["echo x > /etc/passwd", /inside data\/ and scratch\//],
	["echo x > data/../out.txt", /inside data\/ and scratch\//],
	["echo x >> /tmp/x", /inside data\/ and scratch\//],
	["cat < /etc/passwd", /inside the workspace/],
	["cat <<EOF\nx\nEOF", /here-documents/],
	["cat <<< hello", /here-documents/],
	["cat <(ls)", /here-documents|process substitution/],
	["echo `id`", /command substitution/],
	["echo $(id)", /variables and substitutions|command substitution/],
	["echo \"$(id)\"", /command substitution/],
	["echo \"${HOME}\"", /command substitution/],
	["echo $HOME", /variables/],
	["ls &", /background/],
	["ls &> out", /background/],
	["(ls)", /subshells/],
	["ls; curl x", /no network/],
	["ls && curl x", /no network/],
	["ls || curl x", /no network/],
	["ls | curl -d @- x", /no network/],
	["ls\ncurl x", /no network/],
	["cat data/x |& cat", /not allowed/],
	["echo x 2>&3", /file descriptor/],
	["echo x >| data/x", /not allowed/],
	["echo 'unterminated", /unterminated/],
	["", /empty/],
	["   ", /empty/],
];

describe("the command policy", () => {
	for (const command of allowed) {
		it(`allows ${JSON.stringify(command).slice(0, 100)}`, () => {
			const verdict = checkCommand(command);
			assert.deepEqual(verdict, { allowed: true }, JSON.stringify(verdict));
			assert.equal(bashApproval({ command }), undefined);
		});
	}
	for (const [command, why] of refused) {
		it(`refuses ${JSON.stringify(command).slice(0, 100)}`, () => {
			const verdict = checkCommand(command);
			assert.equal(verdict.allowed, false, "expected a refusal");
			if (!verdict.allowed) assert.match(verdict.reason, why);
			assert.match(bashApproval({ command }) ?? "", /refused by the Datadog triage command policy/);
		});
	}

	it("keeps quoted operators inside the program they belong to", () => {
		assert.deepEqual(checkCommand("python3 -c 'a = 1; b = a | 2; print(a > b)'"), { allowed: true });
		assert.deepEqual(checkCommand("jq -r '.a | .b' data/x.json"), { allowed: true });
		assert.equal(checkCommand("echo 'a' ; curl x").allowed, false);
	});

	it("refuses a command that is not a string", () => {
		assert.equal(bashApproval({})?.includes("empty"), true);
	});
});

describe("python source screening", () => {
	it("passes analysis and refuses networking, subprocesses and file removal", () => {
		assert.equal(pythonProblem("import json, statistics\nfrom collections import Counter\nprint(1)"), undefined);
		assert.match(pythonProblem("import json\nimport socket") ?? "", /socket/);
		assert.match(pythonProblem("from subprocess import run") ?? "", /subprocess/);
		assert.match(pythonProblem("import os\nos.unlink('x')") ?? "", /os\.unlink/);
		assert.match(pythonProblem("import pathlib\npathlib.Path('x').unlink()") ?? "", /unlink/);
		assert.match(pythonProblem("eval('1')") ?? "", /eval/);
		assert.equal(pythonProblem("print('import socket is a word in a log line')".replace("import socket", "a word")), undefined);
	});
});

describe("the file tools", () => {
	it("write and edit change files in data/ and scratch/ only", () => {
		for (const path of ["scratch/a.py", "./scratch/a.py", "data/notes.md", "scratch/sub/dir/x.txt", "/workspace/0123456789abcdef/scratch/a.py", "/workspace/0123456789abcdef/data/x.json"]) {
			assert.equal(checkFileTool("write", { path, content: "x" }), undefined, path);
			assert.equal(checkFileTool("edit", { path, edits: [{ oldText: "a", newText: "b" }] }), undefined, path);
		}
		for (const path of ["", "x.txt", "src/a.py", "data", "scratch/", "../x", "scratch/../x", "data/../../etc/passwd", "/etc/passwd", "/workspace/other/scratch/a.py", "/tmp/0123456789abcdef/../x", "~/x", ".github/workflows/x.yml"]) {
			assert.match(checkFileTool("write", { path, content: "x" }) ?? "", /data\/ and scratch\/ only/, path);
			assert.match(checkFileTool("edit", { path, edits: [] }) ?? "", /data\/ and scratch\/ only/, path);
		}
	});

	it("screens python files in write and edit like python commands", () => {
		assert.match(checkFileTool("write", { path: "scratch/a.py", content: "import socket\n" }) ?? "", /socket/);
		assert.match(checkFileTool("edit", { path: "scratch/a.py", edits: [{ oldText: "x", newText: "import subprocess" }] }) ?? "", /subprocess/);
		assert.equal(checkFileTool("write", { path: "scratch/a.txt", content: "import socket\n" }), undefined, "only python files are screened");
	});

	it("reads a workspace path the way the sandbox shows it", () => {
		assert.equal(workspaceRelative("/workspace/0123456789abcdef/data/x.json"), "data/x.json");
		assert.equal(workspaceRelative("./data/x.json"), "data/x.json");
		assert.equal(workspaceRelative("/etc/passwd"), undefined);
		assert.equal(workspaceRelative("a/../b"), undefined);
	});
});
