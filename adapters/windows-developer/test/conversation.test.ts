import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { windowsDeveloperChat } from "../src/chat.ts";
import { profile } from "../src/profile.ts";

describe("the Windows developer in conversations", () => {
	const chat = windowsDeveloperChat({ CHAT_REPOSITORY_URL: "https://github.com/acme/app", CHAT_REPOSITORY_REF: "main" } as NodeJS.ProcessEnv);
	const [tool] = chat.jobTools!;

	it("offers the change as one job tool, and a change holds the machine's build for its whole run", () => {
		assert.deepEqual(chat.jobTools!.map((candidate) => candidate.name), ["windows_develop"]);
		assert.match(chat.instructions!, /windows_develop/);
		assert.doesNotMatch(chat.instructions!, /instruct:/);
		assert.deepEqual(chat.jobResources!("code.windows", {}), ["windows-build"]);
		assert.equal(chat.jobResources!("other", {}), undefined);
	});

	it("plans a code.windows job, with named build and test profiles only", async () => {
		const planned = (await tool!.plan({ build: "release", tests: ["unit", "smoke"], instruction: "fix the path handling" })) as any;
		assert.deepEqual(planned.capability, { id: "code.windows", version: "1" });
		assert.deepEqual(planned.input, { repository: { url: "https://github.com/acme/app", ref: "main" }, instruction: "fix the path handling", build: { name: "release" }, tests: ["unit", "smoke"] });
		assert.equal(planned.label, "change: fix the path handling");
		assert.deepEqual(((await tool!.plan({ instruction: "just do it" })) as any).input, { repository: { url: "https://github.com/acme/app", ref: "main" }, instruction: "just do it" });
		assert.ok(profile.capabilities.some((c) => c.id === planned.capability.id && c.version === planned.capability.version));
	});

	it("refuses a command where a profile name belongs, an empty instruction and a missing repository", async () => {
		assert.ok("refuse" in (await tool!.plan({ build: "msbuild /t:evil", instruction: "fix" })));
		assert.ok("refuse" in (await tool!.plan({ tests: ["unit; calc.exe"], instruction: "fix" })));
		assert.ok("refuse" in (await tool!.plan({ build: "release", instruction: " " })));
		assert.ok("refuse" in (await windowsDeveloperChat({} as NodeJS.ProcessEnv).jobTools![0]!.plan({ instruction: "x" })));
	});
});
