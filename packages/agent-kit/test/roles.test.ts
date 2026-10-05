import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { findViolations } from "../../../scripts/check-roles.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function fakeWorkspace(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "kit-roles-"));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}
const pkg = (name: string) => JSON.stringify({ name });

describe("workspace boundaries", () => {
	it("the real workspace has none: roles use the kit and the SDK, never each other", () => {
		assert.deepEqual(findViolations(repoRoot), []);
	});

	it("catches a role that imports another role, by relative path and by package name", () => {
		const root = fakeWorkspace({
			"adapters/a/package.json": pkg("@somework/a"),
			"adapters/b/package.json": pkg("@somework/b"),
			"adapters/a/src/main.ts": 'import { x } from "../../b/src/x.ts";\nimport "@somework/b/thing";\nimport { ok } from "@somework/agent-kit";\nconst y = await import("@somework/b");\n',
			"adapters/b/src/x.ts": 'export const x = 1; import { z } from "./z.ts";',
		});
		const found = findViolations(root);
		assert.deepEqual(found.map((v) => [v.file, v.specifier]).sort(), [
			["adapters/a/src/main.ts", "../../b/src/x.ts"],
			["adapters/a/src/main.ts", "@somework/b"],
			["adapters/a/src/main.ts", "@somework/b/thing"],
		]);
	});

	it("catches the kit importing a role, and the SDK importing the kit", () => {
		const root = fakeWorkspace({
			"adapters/a/package.json": pkg("@somework/a"),
			"packages/agent-kit/src/x.ts": 'import { p } from "../../../adapters/a/src/profile.ts";',
			"sdk/typescript/src/y.ts": 'import { k } from "@somework/agent-kit";',
		});
		assert.deepEqual(findViolations(root).map((v) => v.file).sort(), ["packages/agent-kit/src/x.ts", "sdk/typescript/src/y.ts"]);
	});
});
