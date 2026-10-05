// A minimal review on the pilot reviewer that approves its (non read-only) command questions, to prove it still claims and completes after a rollout.
import { requester, sleep } from "./lib.ts";

const client = requester();
const task = await client.submitTask({
	capability: { id: "code.review", version: "3" },
	input: { repository: { url: "https://github.com/jimmystridh/jimmystridh.git", ref: "main" }, focus: "one-line sanity check only; no deep review", budget: { maxTokens: 40_000, maxMinutes: 6 } },
});
console.log("submitted", task.taskId);
const deadline = Date.now() + 7 * 60_000;
let approvals = 0;
for (;;) {
	const current = await client.getTask(task.taskId);
	if (current.state === "input_required") {
		approvals += 1;
		await client.provideInput(task.taskId, { approved: true });
		await sleep(1000);
		continue;
	}
	if (["succeeded", "failed", "canceled", "expired", "rejected"].includes(current.state)) {
		console.log(JSON.stringify({ state: current.state, approvals, summary: String(current.result?.summary ?? current.result?.verdict ?? "").slice(0, 200), failure: current.failure }));
		process.exit(current.state === "succeeded" ? 0 : 1);
	}
	if (Date.now() > deadline) {
		console.log("timeout waiting", current.state);
		process.exit(1);
	}
	await sleep(2000);
}
