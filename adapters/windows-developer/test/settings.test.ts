import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadWindowsSettings } from "../src/settings.ts";

describe("the role's settings", () => {
	it("add the profiles file to the kit's Windows environment settings", () => {
		const settings = loadWindowsSettings({ WINDOWS_WORKSPACE_ROOT: "C:\\somework\\workspaces", WINDOWS_PROFILES_FILE: "C:\\p.json", WINDOWS_PASS_ENV: "X" }, () => true);
		assert.equal(settings.profilesFile, "C:\\p.json");
		assert.equal(settings.root, "C:/somework/workspaces");
		assert.deepEqual(settings.passEnv, ["X"]);
		assert.equal(loadWindowsSettings({ WINDOWS_WORKSPACE_ROOT: "C:\\ws" }, () => true).profilesFile, undefined);
	});
});
