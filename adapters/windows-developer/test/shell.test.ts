import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { baseEnvironment, bashCandidates, chooseBash, defaultPathDirectories, GIT_CONFIG, isWslLauncher } from "../src/shell.ts";
import { loadWindowsSettings } from "../src/settings.ts";

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
