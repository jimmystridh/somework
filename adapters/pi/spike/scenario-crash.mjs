import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "./lib.mjs";

const tool = process.argv[2] ?? "slow_read";
const dir = mkdtempSync(join(tmpdir(), "pi-spike-"));
const db = join(dir, "state.sqlite"), marker = join(dir, "marker.log");
const run = (role) => spawn("node", ["child.mjs", role, db, marker, tool], { stdio: ["ignore", "pipe", "inherit"] });
const collect = (child) => { let out = ""; child.stdout.on("data", (d) => (out += d)); return () => out; };

console.log(`## scenario: kill -9 during ${tool} (storage ${dir})`);
const first = run("first"); const firstOut = collect(first);
for (let i = 0; i < 100 && !(existsSync(marker) && readFileSync(marker, "utf8").includes(`${tool} start`)); i++) await sleep(100);
first.kill("SIGKILL");
await new Promise((r) => first.once("exit", r));
console.log("process 1 killed mid-tool. output:\n" + firstOut().trim());

const second = run("resume"); const secondOut = collect(second);
await new Promise((r) => second.once("exit", r));
console.log("process 2 (resume + same requestId) output:\n" + secondOut().trim());
console.log("marker log:\n" + readFileSync(marker, "utf8").trim());
