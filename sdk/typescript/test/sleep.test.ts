import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sleep } from "../src/backoff.ts";

describe("sleep", () => {
	it("resolves promptly when its signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const started = Date.now();
		await sleep(10_000, controller.signal);

		assert.ok(Date.now() - started < 100, "sleep should not wait for the timer after an abort");
	});
});
