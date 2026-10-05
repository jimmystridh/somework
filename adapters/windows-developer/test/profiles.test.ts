import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { InvalidInput } from "@somework/agent-kit";
import { loadProfiles, parseProfiles, ProfilesError, selectProfiles } from "../src/profiles.ts";

const example = new URL("../deploy/profiles.example.json", import.meta.url).pathname;
const valid = () => parseProfiles({ build: { release: { command: "make" }, "debug.x64": { command: "make debug", timeoutMinutes: 5, blockPushOnFailure: false } }, test: { unit: { command: "make test" }, smoke: { command: "make smoke" } } });

describe("profiles file", () => {
	it("loads the shipped example and fills in the defaults", () => {
		const profiles = loadProfiles(example);
		assert.equal(profiles.build["example-build"]!.blockPushOnFailure, true);
		assert.equal(profiles.build["example-build"]!.timeoutMinutes, 120);
		assert.equal(profiles.test["example-tests"]!.timeoutMinutes, 30);
		assert.deepEqual(profiles.encoding.legacyGlobs, ["**/*.cpp", "**/*.h", "**/*.rc"]);
		assert.equal(profiles.encoding.blockPush, true);
		assert.doesNotThrow(() => JSON.parse(readFileSync(example, "utf8")));
	});

	it("defaults: block on failure, one hour, no extra environment", () => {
		const profile = valid().build.release!;
		assert.deepEqual(profile, { command: "make", timeoutMinutes: 60, env: {}, blockPushOnFailure: true });
		assert.equal(valid().build["debug.x64"]!.blockPushOnFailure, false);
	});

	it("without a file there are no profiles (and so nothing can be selected)", () => {
		const none = loadProfiles(undefined);
		assert.deepEqual([none.build, none.test], [{}, {}]);
	});

	it("refuses typos, bad names, bad values and credentials in the environment", () => {
		const bad: [unknown, RegExp][] = [
			[{ builds: {} }, /unknown setting "builds"/],
			[{ build: { Release: { command: "x" } } }, /not a valid profile name/],
			[{ build: { a: { command: "" } } }, /command must be a non-empty string/],
			[{ build: { a: { command: "x", comand: "y" } } }, /unknown setting "comand"/],
			[{ build: { a: { command: "x", timeoutMinutes: 0 } } }, /timeoutMinutes/],
			[{ build: { a: { command: "x", timeoutMinutes: 999 } } }, /timeoutMinutes/],
			[{ build: { a: { command: "x", cwd: "C:\\x" } } }, /relative path inside the workspace/],
			[{ build: { a: { command: "x", cwd: "../x" } } }, /relative path inside the workspace/],
			[{ build: { a: { command: "x", cwd: "/etc" } } }, /relative path inside the workspace/],
			[{ build: { a: { command: "x", env: { NUGET_TOKEN: "x" } } } }, /looks like a credential/],
			[{ build: { a: { command: "x", env: { "bad-name": "x" } } } }, /not a valid variable name/],
			[{ build: { a: { command: "x", env: { A: 1 } } } }, /must be a string/],
			[{ build: { a: { command: "x", blockPushOnFailure: "no" } } }, /blockPushOnFailure/],
			[{ encoding: { legacyGlobs: "*.cpp" } }, /list of non-empty strings/],
			[{ encoding: { blockPush: "yes" } }, /blockPush/],
			["nope", /must be an object/],
		];
		for (const [raw, message] of bad) assert.throws(() => parseProfiles(raw), (error: Error) => error instanceof ProfilesError && message.test(error.message), JSON.stringify(raw));
	});

	it("reports an unreadable file clearly", () => {
		assert.throws(() => loadProfiles("/no/such/profiles.json"), /cannot read the profiles file/);
	});
});

describe("selecting profiles for a job", () => {
	it("accepts configured names", () => {
		assert.deepEqual(selectProfiles({ build: { name: "release" }, tests: ["unit", "smoke", "unit"] }, valid()), { build: "release", tests: ["unit", "smoke"] });
		assert.deepEqual(selectProfiles({}, valid()), { tests: [] });
	});

	it("refuses arbitrary commands instead of ignoring them", () => {
		for (const build of [{ name: "release", command: "del /s /q C:\\" }, { command: "whoami" }, { name: "release", cwd: ".." }]) {
			assert.throws(() => selectProfiles({ build }, valid()), (error: Error) => error instanceof InvalidInput, JSON.stringify(build));
		}
		assert.throws(() => selectProfiles({ build: { name: "release", command: "x" } }, valid()), /only pre-configured build profiles/);
	});

	it("refuses unknown names, including names that exist on every object", () => {
		assert.throws(() => selectProfiles({ build: { name: "nope" } }, valid()), /unknown build profile "nope"; configured: release, debug\.x64/);
		assert.throws(() => selectProfiles({ build: { name: "constructor" } }, valid()), /unknown build profile/);
		assert.throws(() => selectProfiles({ tests: ["__proto__"] }, valid()), /unknown test profile/);
		assert.throws(() => selectProfiles({ tests: "unit" }, valid()), /list of at most 10/);
		assert.throws(() => selectProfiles({ tests: Array.from({ length: 11 }, () => "unit") }, valid()), /at most 10/);
		assert.throws(() => selectProfiles({ build: "release" }, valid()), /build must be \{name\}/);
		assert.throws(() => selectProfiles({ build: { name: "x" } }, parseProfiles({})), /configured: none/);
	});
});
