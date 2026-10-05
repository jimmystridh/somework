import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { loadConfig } from "@somework/agent-kit";
import { loadWindowsSettings } from "../src/settings.ts";

const deploy = new URL("../deploy/", import.meta.url).pathname;
const repoRoot = new URL("../../../", import.meta.url).pathname;
const scripts = readdirSync(deploy).filter((name) => name.endsWith(".ps1"));
const pwsh = spawnSync("sh", ["-c", "command -v pwsh"], { encoding: "utf8" }).stdout.trim();

describe("Windows packaging scripts", () => {
	it("are plain ASCII: Windows PowerShell 5.1 reads a BOM-less file in the ANSI code page", () => {
		for (const name of scripts) assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(readFileSync(join(deploy, name), "utf8")), `${name} has non-ASCII characters`);
	});

	it("use no syntax that Windows PowerShell 5.1 does not have", () => {
		const forbidden: [RegExp, string][] = [
			[/&&|\|\|/, "pipeline chain operators (&& / ||)"],
			[/\?\?/, "null-coalescing"],
			[/\s\?\s[^|]*\s:\s/, "ternary operator"],
			[/-Parallel\b/, "ForEach-Object -Parallel"],
			[/-AsHashtable\b/, "ConvertFrom-Json -AsHashtable"],
			[/ConvertFrom-Json[^\n]*-Depth\b/, "ConvertFrom-Json -Depth"],
			[/-AsByteStream\b/, "-AsByteStream"],
			[/\$IsWindows\b|\$IsLinux\b/, "$IsWindows"],
			[/\bpwsh\b/, "pwsh"],
			[/-ErrorAction\s+Ignore\b.*\?\./, "null-conditional"],
			[/\w\?\.\w|\w\?\[/, "null-conditional access"],
		];
		for (const name of scripts) {
			const code = readFileSync(join(deploy, name), "utf8").split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
			for (const [pattern, what] of forbidden) assert.ok(!pattern.test(code), `${name} uses ${what}`);
		}
	});

	it("parse with the PowerShell parser, and the firewall range arithmetic is right", { skip: pwsh === "" ? "pwsh is not installed here" : false }, () => {
		const parse = spawnSync(pwsh, ["-NoProfile", "-Command", `$bad = 0; foreach ($f in Get-ChildItem '${deploy}*.ps1') { $e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$t, [ref]$e); if (@($e).Count -gt 0) { $bad++; Write-Output ($f.Name + ': ' + $e[0].Message) } }; exit $bad`], { encoding: "utf8" });
		assert.equal(parse.status, 0, parse.stdout + parse.stderr);
		const selfTest = spawnSync(pwsh, ["-NoProfile", "-File", join(deploy, "firewall.ps1"), "-SelfTest"], { encoding: "utf8" });
		assert.equal(selfTest.status, 0, selfTest.stdout + selfTest.stderr);
		assert.ok(!/FAIL:/.test(selfTest.stdout));
	});

	it("ship settings examples that the service accepts", () => {
		const env: Record<string, string> = {};
		for (const line of readFileSync(join(deploy, "agent.env.example"), "utf8").split("\n")) {
			const text = line.trim();
			if (text === "" || text.startsWith("#")) continue;
			const index = text.indexOf("=");
			env[text.slice(0, index)] = text.slice(index + 1);
		}
		const settings = loadWindowsSettings(env, () => true);
		assert.equal(settings.root, "C:/somework/workspaces");
		const config = loadConfig({ ...env, SANDBOX_URL: "local://windows", SANDBOX_WORKSPACES: settings.root });
		assert.equal(config.git.tokenHosts.join(","), "github.com");
		assert.equal(config.concurrency, 1);
		assert.equal(config.somework.requireTls, true);
	});

	it("ship an allow-list example of valid entries", () => {
		const entries = readFileSync(join(deploy, "firewall-allow.example.txt"), "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
		assert.ok(entries.length >= 5);
		for (const entry of entries) assert.match(entry, /^([a-z0-9.-]+|[0-9./-]+)$/i, entry);
	});

	it("keep the role boundaries (no role imports another role)", () => {
		const check = spawnSync("node", ["scripts/check-roles.ts"], { cwd: repoRoot, encoding: "utf8" });
		assert.equal(check.status, 0, check.stdout + check.stderr);
	});
});

describe("smoke test", () => {
	it("passes on this machine (POSIX stand-ins for the Windows parts)", { timeout: 280_000 }, () => {
		const run = spawnSync("node", ["deploy/smoke.ts"], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 270_000 });
		const lines = run.stdout.split("\n").filter((line) => /^(PASS|FAIL):/.test(line));
		assert.equal(run.status, 0, run.stdout.slice(-1500));
		assert.ok(lines.length >= 7 && lines.every((line) => line.startsWith("PASS:")), lines.join("\n"));
	});
});
