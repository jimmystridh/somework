import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { repoRoot, startDomain } from "../../../sdk/typescript/test/harness.ts";
import card from "../card.json" with { type: "json" };

const here = new URL(".", import.meta.url).pathname;
const binary = process.env.SOMEWORK_BIN ?? join(repoRoot, "dist/somework");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("the card in a real domain", () => {
	it("is accepted and approved by the domain's own card validation", { skip: existsSync(binary) ? false : `no domain binary at ${binary}: set SOMEWORK_BIN` }, async () => {
		// startDomain registers the card (with its id replaced) through `somework admin register-card --approve`, which validates it
		const domain = await startDomain({ cardFile: join(here, "../card.json") });
		cleanups.push(() => domain.close());
		assert.ok(domain.url.startsWith("http://127.0.0.1:"));
		assert.equal(card.capabilities[0]!.id, "code.cluster");
	});
});
