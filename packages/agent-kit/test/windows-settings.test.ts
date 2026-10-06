import assert from "node:assert/strict";
import { test } from "node:test";
import { loadWindowsEnvSettings } from "../src/windows/settings.ts";

const base = { WINDOWS_WORKSPACE_ROOT: "C:/somework/workspaces", WINDOWS_BASH: "C:/Program Files/Git/bin/bash.exe" };
const exists = (): boolean => true;

test("the health endpoint stays on loopback unless an address is named", () => {
	assert.equal(loadWindowsEnvSettings(base, exists).healthBind, undefined);
	assert.equal(loadWindowsEnvSettings({ ...base, WINDOWS_HEALTH_BIND: "10.10.10.45" }, exists).healthBind, "10.10.10.45");
});

test("a wildcard or malformed health address is refused", () => {
	for (const bad of ["0.0.0.0", "::", "localhost", "10.10.10", "10.10.10.300", "10.10.10.45:8081"]) {
		assert.throws(() => loadWindowsEnvSettings({ ...base, WINDOWS_HEALTH_BIND: bad }, exists), /WINDOWS_HEALTH_BIND/, bad);
	}
});
