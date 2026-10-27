import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { baseEnvironment, bashCandidates, chooseBash, defaultPathDirectories, credentialHelperScript, GIT_CONFIG, gitConfigFor, isWslLauncher } from "../src/windows/shell.ts";
import { loadWindowsEnvSettings as loadWindowsSettings } from "../src/windows/settings.ts";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

describe("choosing bash", () => {
	it("looks in Program Files, Program Files (x86) and the per-user install, in that order", () => {
		assert.deepEqual(bashCandidates({ ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\svc\\AppData\\Local" }), [GIT_BASH, "C:\\Program Files (x86)\\Git\\bin\\bash.exe", "C:\\Users\\svc\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"]);
		assert.deepEqual(bashCandidates({}), [GIT_BASH]);
	});

	it("takes the first candidate that exists and an explicit path over all of them", () => {
		const candidates = bashCandidates({ "ProgramFiles(x86)": "C:\\Program Files (x86)" });
		assert.equal(chooseBash({ candidates, exists: (path) => path.includes("(x86)") }), "C:\\Program Files (x86)\\Git\\bin\\bash.exe");
		assert.equal(chooseBash({ explicit: "D:\\tools\\bash.exe", candidates, exists: () => true }), "D:\\tools\\bash.exe");
	});

	it("fails clearly when there is no Git for Windows bash, or the explicit one is missing", () => {
		assert.throws(() => chooseBash({ candidates: [GIT_BASH], exists: () => false }), /no Git for Windows bash found/);
		assert.throws(() => chooseBash({ explicit: "D:\\nope\\bash.exe", candidates: [GIT_BASH], exists: () => false }), /does not exist/);
	});

	it("never selects the WSL launcher, whatever its spelling", () => {
		for (const wsl of ["C:\\Windows\\System32\\bash.exe", "c:/windows/sysnative/bash.exe", "C:\\WINDOWS\\System32\\BASH.EXE"]) {
			assert.equal(isWslLauncher(wsl), true, wsl);
			assert.throws(() => chooseBash({ explicit: wsl, candidates: [], exists: () => true }), /WSL launcher/);
		}
		assert.throws(() => chooseBash({ candidates: ["C:\\Windows\\System32\\bash.exe"], exists: () => true }), /no Git for Windows bash found/);
		assert.equal(isWslLauncher(GIT_BASH), false);
	});
});

describe("the environment of a command", () => {
	const host = { ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".COM;.EXE", GIT_TOKEN: "ghp_leak", PI_AUTH_FILE: "C:\\secrets\\auth.json", SOMEWORK_KEY_FILE: "C:\\secrets\\key.json", ANTHROPIC_API_KEY: "sk-leak", PATH: "C:\\evil", MSBUILD_X: "1" };

	it("contains only the explicit PATH, a home inside the workspace root, the default pass-through names and the configured ones", () => {
		const env = baseEnvironment({ root: "C:\\somework\\ws", host, passEnv: ["MSBUILD_X", "NOT_SET"] });
		assert.equal(env.PATH, defaultPathDirectories(host).join(";"));
		assert.ok(!env.PATH!.includes("evil"));
		assert.equal(env.HOME, "C:\\somework\\ws\\.home");
		assert.equal(env.TEMP, "C:\\somework\\ws\\.tmp");
		assert.equal(env.GIT_CONFIG_GLOBAL, "C:\\somework\\ws\\.home\\.gitconfig");
		assert.equal(env.GCM_INTERACTIVE, "never");
		assert.equal(env.ComSpec, host.ComSpec);
		assert.equal(env.MSBUILD_X, "1");
		assert.ok(!("NOT_SET" in env));
		for (const name of ["GIT_TOKEN", "PI_AUTH_FILE", "SOMEWORK_KEY_FILE", "ANTHROPIC_API_KEY"]) assert.ok(!(name in env), `${name} must not reach a command`);
	});

	it("puts Git for Windows' unix tools and Node.js on the default PATH", () => {
		const dirs = defaultPathDirectories({});
		assert.ok(dirs.includes("C:\\Program Files\\Git\\usr\\bin"));
		assert.ok(dirs.includes("C:\\Program Files\\nodejs"));
		assert.ok(dirs.includes("C:\\Windows\\System32"));
	});

	it("resets git's credential helpers and keeps long paths on", () => {
		assert.match(GIT_CONFIG, /longpaths = true/);
		assert.match(GIT_CONFIG, /\[credential\]\n\thelper =\n/);
		assert.match(GIT_CONFIG, /autocrlf = false/);
	});
});

describe("settings", () => {
	const exists = () => true;
	it("accepts a drive-letter root, normalises it, and reads the optional settings", () => {
		const settings = loadWindowsSettings({ WINDOWS_WORKSPACE_ROOT: "C:\\somework\\workspaces\\", WINDOWS_PATH_DIRS: "C:\\a;C:\\b", WINDOWS_PASS_ENV: "X, Y", WINDOWS_PROFILES_FILE: "C:\\p.json", WINDOWS_MAX_OUTPUT_BYTES: "4096" }, exists);
		assert.equal(settings.root, "C:/somework/workspaces");
		assert.deepEqual(settings.pathDirectories, ["C:\\a", "C:\\b"]);
		assert.deepEqual(settings.passEnv, ["X", "Y"]);
		assert.equal(settings.maxOutputBytes, 4096);
		assert.equal(settings.bash, GIT_BASH);
	});

	it("refuses roots that are relative, UNC, short-named or missing, and silly limits", () => {
		for (const root of ["somework\\ws", "\\\\server\\share\\ws", "C:ws", "C:\\PROGRA~1\\ws", "/srv/ws"]) assert.throws(() => loadWindowsSettings({ WINDOWS_WORKSPACE_ROOT: root }, exists), /WINDOWS_WORKSPACE_ROOT|drive|UNC|short names|absolute/, root);
		assert.throws(() => loadWindowsSettings({}, exists), /WINDOWS_WORKSPACE_ROOT/);
		assert.throws(() => loadWindowsSettings({ WINDOWS_WORKSPACE_ROOT: "C:\\ws", WINDOWS_MAX_OUTPUT_BYTES: "5" }, exists), /WINDOWS_MAX_OUTPUT_BYTES/);
		assert.throws(() => loadWindowsSettings({ WINDOWS_WORKSPACE_ROOT: "C:\\ws" }, () => false), /no Git for Windows bash/);
	});
});

describe("the shell's git credential helper", () => {
	const run = (script: string, input: string, verb = "get"): string => {
		const dir = mkdtempSync(join(tmpdir(), "helper-"));
		writeFileSync(join(dir, "helper.sh"), script);
		return execFileSync("sh", [join(dir, "helper.sh"), verb], { input }).toString();
	};
	const files = () => {
		const dir = mkdtempSync(join(tmpdir(), "tokens-"));
		writeFileSync(join(dir, "default"), "default-token\n");
		writeFileSync(join(dir, "acme"), "acme-token\n");
		return { default: join(dir, "default"), acme: join(dir, "acme"), missing: join(dir, "missing") };
	};
	const ask = (host: string, path: string) => `protocol=https\nhost=${host}\npath=${path}\n\n`;

	it("answers for a configured host with the default token and with the owner's own token, read when asked", () => {
		const f = files();
		const script = credentialHelperScript({ hosts: ["github.com"], tokenFile: f.default, ownerTokenFiles: { acme: f.acme } });
		assert.equal(run(script, ask("github.com", "Other/repo.git")), "username=x-access-token\npassword=default-token\n");
		assert.equal(run(script, ask("github.com", "ACME/widgets.git")), "username=x-access-token\npassword=acme-token\n");
		writeFileSync(f.acme, "rotated\n");
		assert.match(run(script, ask("github.com", "acme/widgets.git")), /password=rotated/);
	});

	it("says nothing for other hosts, for store and erase, and when there is no readable token file", () => {
		const f = files();
		const script = credentialHelperScript({ hosts: ["github.com"], tokenFile: f.default, ownerTokenFiles: {} });
		assert.equal(run(script, ask("evil.example", "acme/x.git")), "");
		assert.equal(run(script, ask("github.example.com", "acme/x.git")), "");
		assert.equal(run(script, ask("github.com", "acme/x.git"), "store"), "");
		assert.equal(run(script, ask("github.com", "acme/x.git"), "erase"), "");
		assert.equal(run(credentialHelperScript({ hosts: ["github.com"], tokenFile: f.missing, ownerTokenFiles: {} }), ask("github.com", "acme/x.git")), "");
	});

	it("is added to the git configuration only when asked for, after the reset of the system helpers", () => {
		assert.equal(gitConfigFor(undefined), GIT_CONFIG);
		const config = gitConfigFor("C:\\somework\\ws\\.home\\git-credential-somework");
		assert.match(config, /\thelper =\n\thelper = !sh 'C:\/somework\/ws\/\.home\/git-credential-somework'\n\tuseHttpPath = true\n$/);
	});

	it("is configured by WINDOWS_SHELL_GIT_AUTH from the role's token settings", () => {
		const base = { WINDOWS_WORKSPACE_ROOT: "C:\\somework\\ws", WINDOWS_BASH: GIT_BASH };
		const exists = () => true;
		assert.equal(loadWindowsSettings(base, exists).shellGitAuth, undefined);
		const settings = loadWindowsSettings({ ...base, WINDOWS_SHELL_GIT_AUTH: "1", GIT_TOKEN_FILE: "C:\\s\\git-token", GIT_TOKEN_OWNERS: "Jimmy=C:\\s\\jimmy" }, exists);
		assert.deepEqual(settings.shellGitAuth, { hosts: ["github.com"], tokenFile: "C:\\s\\git-token", ownerTokenFiles: { jimmy: "C:\\s\\jimmy" } });
		assert.throws(() => loadWindowsSettings({ ...base, WINDOWS_SHELL_GIT_AUTH: "1" }, exists), /needs GIT_TOKEN_FILE/);
	});
});
