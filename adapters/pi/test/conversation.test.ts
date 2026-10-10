import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { developerChat } from "../src/chat.ts";
import { profile } from "../src/profile.ts";

describe("the developer in conversations", () => {
	const chat = developerChat({ CHAT_REPOSITORY_URL: "https://github.com/acme/app", CHAT_REPOSITORY_REF: "main" } as NodeJS.ProcessEnv);
	const [tool] = chat.jobTools!;

	it("offers the code change as one job tool and says so in its standing orders", () => {
		assert.deepEqual(chat.jobTools!.map((candidate) => candidate.name), ["code_agent"]);
		assert.match(chat.instructions!, /code_agent/);
		assert.doesNotMatch(chat.instructions!, /instruct:/);
	});

	it("plans a code.agent job on the configured repository", async () => {
		assert.deepEqual(await tool!.plan({ instruction: "add a health endpoint" }), {
			capability: { id: "code.agent", version: "2" },
			input: { repository: { url: "https://github.com/acme/app", ref: "main" }, instruction: "add a health endpoint" },
			label: "change: add a health endpoint",
		});
	});

	it("takes another repository and ref, only over https", async () => {
		const planned = (await tool!.plan({ repo: "https://github.com/acme/other", ref: "develop", instruction: "fix the typo" })) as any;
		assert.deepEqual(planned.input.repository, { url: "https://github.com/acme/other", ref: "develop" });
		assert.ok("refuse" in (await tool!.plan({ repo: "ssh://git@github.com/a/b", instruction: "fix" })));
		assert.ok("refuse" in (await tool!.plan({ instruction: "  " })), "no instruction");
	});

	it("refuses without a repository when none is configured", async () => {
		assert.ok("refuse" in (await developerChat({} as NodeJS.ProcessEnv).jobTools![0]!.plan({ instruction: "do something" })));
	});

	it("can only start work for a card capability", async () => {
		const planned = (await tool!.plan({ instruction: "x" })) as any;
		assert.ok(profile.capabilities.some((c) => c.id === planned.capability.id && c.version === planned.capability.version));
	});
});
