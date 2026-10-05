import { ctx, open } from "./lib.mjs";

const [role, db, marker, tool = "slow_read", requestId = "job-1"] = process.argv.slice(2);
const { harness, modelChoice } = await open({ db, marker, tool });
const say = (line) => process.stdout.write(line + "\n");
if (role === "resume") harness.resume();
const root = await harness.root(ctx, { agent: { model: modelChoice } });
const submission = await root.submit({ type: "input", content: "do the work", requestId }, ctx);
say(`SUBMITTED id=${submission.id}`);
const settled = await submission.wait(ctx);
say(`SETTLED status=${settled.status}${settled.reason ? " reason=" + settled.reason : ""}`);
const view = await root.viewState(ctx);
const entries = view.value?.entries ?? [];
say(`ENTRIES kinds=${entries.map((e) => e.kind).join(",")}`);
for (const e of entries) if (e.kind === "pi.tool-result") say(`TOOLRESULT ${JSON.stringify(e.data).slice(0, 200)}`);
await harness.close(ctx);
