import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCommand, type ClassifyContext } from "../src/classifier/index.ts";
import { LOCAL, REMOTE } from "./classifier-support.ts";

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;
const doubleQuote = (text: string): string => `"${text.replace(/(["\\$`])/g, "\\$1")}"`;

/** Ways to put a command somewhere a shell would still run it. Each takes the command and returns a command line. */
const WRAPPERS: [name: string, wrap: (command: string) => string][] = [
	["plain", (c) => c],
	["a trailing comment", (c) => `${c} # nothing to see`],
	["a trailing semicolon", (c) => `${c};`],
	["a leading newline", (c) => `\n${c}`],
	["after another command", (c) => `echo start; ${c}`],
	["after and-and", (c) => `true && ${c}`],
	["after or-or", (c) => `false || ${c}`],
	["in the background", (c) => `${c} &`],
	["in a subshell", (c) => `(${c})`],
	["in braces", (c) => `{ ${c}; }`],
	["in an if", (c) => `if true; then ${c}; fi`],
	["in a for loop", (c) => `for i in 1 2; do ${c}; done`],
	["in a while loop", (c) => `while true; do ${c}; break; done`],
	["in a case", (c) => `case x in x) ${c} ;; esac`],
	["in a function", (c) => `f() { ${c}; }; f`],
	["in command substitution", (c) => `echo $(${c})`],
	["in backticks", (c) => `echo \`${c}\``],
	["in a quoted command substitution", (c) => `echo "$(${c})"`],
	["in process substitution", (c) => `cat <(${c})`],
	["in a variable assignment", (c) => `x=$(${c})`],
	["after sudo", (c) => `sudo ${c}`],
	["after sudo -u", (c) => `sudo -u root ${c}`],
	["after env", (c) => `env FOO=bar ${c}`],
	["after nohup", (c) => `nohup ${c}`],
	["after nice", (c) => `nice -n 5 ${c}`],
	["after timeout", (c) => `timeout 30 ${c}`],
	["after time", (c) => `time ${c}`],
	["after command", (c) => `command ${c}`],
	["after exec", (c) => `exec ${c}`],
	["after busybox", (c) => `busybox ${c}`],
	["after stdbuf", (c) => `stdbuf -oL ${c}`],
	["after watch", (c) => `watch -n 1 ${quote(c)}`],
	["in bash -c", (c) => `bash -c ${quote(c)}`],
	["in sh -c with double quotes", (c) => `sh -c ${doubleQuote(c)}`],
	["in bash -lc", (c) => `bash -lc ${quote(c)}`],
	["in nested bash -c", (c) => `bash -c ${quote(`bash -c ${quote(c)}`)}`],
	["in eval", (c) => `eval ${quote(c)}`],
	["in a here-document to bash", (c) => `bash <<EOF\n${c}\nEOF`],
	["in a quoted here-document to sh", (c) => `sh <<'EOF'\n${c}\nEOF`],
	["in a here-string to bash", (c) => `bash <<< ${quote(c)}`],
	["piped from echo into sh", (c) => `echo ${quote(c)} | sh`],
	["piped from printf into bash", (c) => `printf %s ${quote(c)} | bash`],
	["in su -c", (c) => `su -c ${quote(c)}`],
	["in ssh", (c) => `ssh agents ${quote(c)}`],
	["in ssh with options", (c) => `ssh -o StrictHostKeyChecking=no -i key js@10.0.0.2 ${quote(c)}`],
	["in ssh through bash -c", (c) => `ssh agents ${quote(`bash -c ${quote(c)}`)}`],
	["in docker exec", (c) => `docker exec agent sh -c ${quote(c)}`],
	["in docker compose exec", (c) => `docker compose exec -T agent sh -c ${quote(c)}`],
	["after xargs", (c) => `echo x | xargs -I{} ${c}`],
	["after find -exec", (c) => `find . -maxdepth 0 -exec ${c} \\;`],
	["with a CRLF line ending", (c) => `${c}\r\n`],
	["after a tab", (c) => `\t${c}`],
	["after a backslash newline", (c) => `echo a \\\n; ${c}`],
];

/** Commands that are destructive wherever they run. */
const DANGEROUS: [command: string, category: string][] = [
	["rm -rf /srv/app", "data"],
	["cat /etc/shadow", "secrets"],
	["cat ~/.ssh/id_rsa", "secrets"],
	["docker system prune -af", "data"],
	["docker volume rm somework_state", "data"],
	["git push --force org main", "git"],
	["git clean -fdx", "git"],
	["iptables -F", "firewall"],
	["ufw allow 22", "firewall"],
	["qm list", "hypervisor"],
	["printenv", "secrets"],
	["psql -c 'DROP TABLE tasks'", "data"],
	["dd if=/dev/zero of=/dev/sda", "data"],
	["git push origin main", "git"],
];

const CONTEXTS: [string, ClassifyContext][] = [["the sandbox", LOCAL], ["a machine", REMOTE]];

describe("a destructive command is still destructive wherever the shell would run it", () => {
	for (const [place, context] of CONTEXTS) {
		for (const [command, category] of DANGEROUS) {
			it(`${command} in ${place}, in ${WRAPPERS.length} wrappings`, () => {
				const missed: string[] = [];
				for (const [name, wrap] of WRAPPERS) {
					const line = wrap(command);
					const verdict = classifyCommand(line, context);
					if (!verdict.destructive) missed.push(`${name}: ${JSON.stringify(line)}`);
				}
				assert.deepEqual(missed, []);
				assert.equal(classifyCommand(command, context).category, category);
			});
		}
	}

	it("a harmless command stays harmless in the wrappings that do not change what it means", () => {
		const harmless = ["ls -la", "docker ps", "git status", "cat README.md", "echo done", "df -h"];
		const innocent = WRAPPERS.filter(([name]) => !/ssh|docker exec|docker compose exec|here-document|here-string|piped|nested|find -exec|xargs|eval|watch|su -c|process substitution/.test(name));
		const wrong: string[] = [];
		for (const command of harmless) for (const [name, wrap] of innocent) {
			const verdict = classifyCommand(wrap(command), LOCAL);
			if (verdict.destructive) wrong.push(`${name}: ${JSON.stringify(wrap(command))}: ${verdict.reason}`);
		}
		assert.deepEqual(wrong, []);
	});

	it("a harmless command stays harmless inside ssh, docker exec and a here-document", () => {
		const wrong: string[] = [];
		for (const command of ["uptime", "df -h", "docker ps", "journalctl -n 20 --no-pager", "curl -fsS http://127.0.0.1:8081/ready"]) {
			for (const [name, wrap] of WRAPPERS.filter(([wrapperName]) => /^in (ssh|docker exec|docker compose exec|a here-document to bash|a quoted here-document to sh|bash -c|sh -c)/.test(wrapperName) && !/ssh with options|through bash/.test(wrapperName))) {
				const verdict = classifyCommand(wrap(command), LOCAL);
				if (verdict.destructive) wrong.push(`${name}: ${JSON.stringify(wrap(command))}: ${verdict.reason}`);
			}
		}
		assert.deepEqual(wrong, []);
	});
});
