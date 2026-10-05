import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "@somework/agent-kit";
import { Identity } from "@somework/sdk";
import { parseAppProfiles } from "../src/app.ts";
import { loadQaSettings } from "../src/settings.ts";

const deploy = new URL("../deploy/", import.meta.url).pathname;
const repoRoot = new URL("../../../", import.meta.url).pathname;
const scripts = readdirSync(deploy).filter((name) => name.endsWith(".ps1"));
const pwsh = spawnSync("sh", ["-c", "command -v pwsh"], { encoding: "utf8" }).stdout.trim();
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const envExample = (): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const line of readFileSync(join(deploy, "agent.env.example"), "utf8").split("\n")) {
		const text = line.trim();
		if (text === "" || text.startsWith("#")) continue;
		const index = text.indexOf("=");
		env[text.slice(0, index)] = text.slice(index + 1);
	}
	return env;
};

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

	it("name this role and its own account, task, rules and port (nothing of the Windows developer's)", () => {
		for (const name of scripts) {
			const text = readFileSync(join(deploy, name), "utf8");
			assert.ok(!/SomeWorkWindowsDeveloper|windows-developer|svc-somework|SomeWork-Agent\b/.test(text), `${name} still names the Windows developer`);
		}
		assert.match(readFileSync(join(deploy, "install-service.ps1"), "utf8"), /\$ServiceUser = 'svc-qa'/);
		assert.match(readFileSync(join(deploy, "install-service.ps1"), "utf8"), /adapters\\qa\\deploy\\run-agent\.ps1/);
		assert.ok(readFileSync(join(deploy, "install-service.ps1"), "utf8").includes("'adapters\\qa\\package.json'"), "the installer checks for this role's package");
		assert.ok(readFileSync(join(deploy, "install-service.ps1"), "utf8").includes("-w '@somework/qa'"), "npm ci installs this workspace");
		assert.match(readFileSync(join(deploy, "firewall.ps1"), "utf8"), /RulePrefix = 'SomeWork-QA'/);
	});

	it("keep the account's description within the 48 characters Windows accepts", () => {
		const description = /New-LocalUser[^\n]*-Description '([^']*)'/.exec(readFileSync(join(deploy, "install-service.ps1"), "utf8"))?.[1];
		assert.ok(description && description.length <= 48, `description is ${description?.length} characters`);
	});

	it("ship settings the service accepts: the kit, the Windows machine and QA's own", () => {
		const env = envExample();
		const settings = loadQaSettings({ ...env, JIRA_URL: "https://jira.example.test", JIRA_TOKEN_FILE: "C:\\t", JIRA_PFX_FILE: "C:\\p", JIRA_PFX_PASSWORD_FILE: "C:\\pp" }, () => true);
		assert.equal(settings.root, "C:/somework/workspaces");
		assert.equal(settings.browser.channel, "msedge");
		assert.deepEqual(settings.browser.allowHosts, ["127.0.0.1", "localhost"]);
		assert.equal(settings.jira?.verifiedLabel, "AgentTested");
		assert.equal(settings.ticketPattern.test("PROJ-12"), true);
		assert.equal(settings.ticketPattern.test("OTHER-12"), false);
		const config = loadConfig({ ...env, SANDBOX_URL: "local://windows", SANDBOX_WORKSPACES: settings.root });
		assert.equal(config.concurrency, 1);
		assert.equal(config.somework.requireTls, true);
		assert.deepEqual(config.skills.allow, ["qa"]);
		assert.equal(config.healthPort, 8082);
	});

	it("ship an application profile example that parses, and an allow-list of valid entries", () => {
		const profiles = parseAppProfiles(JSON.parse(readFileSync(join(deploy, "profiles.example.json"), "utf8")));
		assert.deepEqual(Object.keys(profiles), ["default"]);
		const entries = readFileSync(join(deploy, "firewall-allow.example.txt"), "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
		assert.ok(entries.length >= 5);
		for (const entry of entries) assert.match(entry, /^([a-z0-9.-]+|[0-9./-]+)$/i, entry);
		assert.ok(entries.some((entry) => entry.startsWith("jira.")), "the ticket system is reachable");
	});

	it("ship an overlay example that records the base skill's hash in the form the loader reads", () => {
		const text = readFileSync(join(deploy, "overlay.example.md"), "utf8");
		assert.match(text.split("\n")[0]!, /^<!-- base-sha256: .+ -->$/);
		assert.ok(text.includes("qa-browser") || text.includes("`qa-browser`"), "it shows the replacement of the browser tool");
	});

	it("keep the role boundaries (no role imports another role)", () => {
		const check = spawnSync("node", ["scripts/check-roles.ts"], { cwd: repoRoot, encoding: "utf8" });
		assert.equal(check.status, 0, check.stdout + check.stderr);
	});
});

describe("keygen", () => {
	const script = join(deploy, "keygen.ts");

	it("writes a key file the SDK can sign with, prints the matching public key, and never overwrites", () => {
		const out = join(mkdtempSync(join(tmpdir(), "qa-key-")), "agent.key.json");
		const run = spawnSync("node", [script, "--id", "agent/qa", "--domain", "development", "--out", out], { encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		const printed = JSON.parse(run.stdout.trim().split("\n").pop()!);
		assert.equal(printed.id, "agent/qa");
		assert.ok(!run.stdout.includes(JSON.parse(readFileSync(out, "utf8")).privateKey), "the private key is not printed");
		if (process.platform !== "win32") assert.equal(statSync(out).mode & 0o777, 0o600);
		const identity = Identity.fromFile(out);
		assert.equal(identity.issuer, "agent:agent/qa");
		const [header, claims, signature] = identity.mintAssertion().split(".");
		const publicKey = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(printed.publicKey, "base64url")]), format: "der", type: "spki" });
		assert.equal(verify(null, Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature!, "base64url")), true);
		assert.notEqual(spawnSync("node", [script, "--id", "agent/qa", "--out", out], { encoding: "utf8" }).status, 0, "an existing key file is never overwritten");
		assert.ok(existsSync(out));
	});
});

describe("smoke test", () => {
	it("passes on this machine (POSIX stand-ins for the Windows parts, a real Edge when there is one)", { timeout: 290_000 }, () => {
		const run = spawnSync("node", ["deploy/smoke.ts"], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", timeout: 280_000, env: { ...process.env, NODE_OPTIONS: "--disable-warning=ExperimentalWarning" } });
		const lines = run.stdout.split("\n").filter((line) => /^(PASS|FAIL):/.test(line));
		assert.equal(run.status, 0, run.stdout.slice(-1800));
		assert.ok(lines.length >= 5 && lines.every((line) => line.startsWith("PASS:")), lines.join("\n"));
	});
});
