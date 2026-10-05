// Smoke test of the QA agent on the machine it will run on (deploy/smoke.ps1 calls this). Also runs on macOS/Linux. Needs no SomeWork
// domain, no model login and no real ticket system: a verification is driven through the kit's handler with a scripted model, against a
// tiny local page and a fake ticket system that demands a client certificate and a bearer token, like the real one.
//   node deploy/smoke.ts            prints PASS/FAIL/INFO lines; exit code 1 when anything failed
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { approvalPolicy, createHandler, Metrics, PiDurableRuntime } from "@somework/agent-kit";
import { scriptedModels } from "@somework/agent-kit/providers/faux";
import { FakeHost, makeRemote, sh } from "@somework/agent-kit/testing";
import { baseEnvironment, bashCandidates, chooseBash, localEnvFactory } from "@somework/agent-kit/windows";
import { AppRunner, type AppProfile } from "../src/app.ts";
import type { BrowserBackend } from "../src/browser/backend.ts";
import { FakeBackend } from "../src/browser/fake.ts";
import { PlaywrightBackend } from "../src/browser/playwright.ts";
import { createQaHooks } from "../src/hooks.ts";
import { JiraClient } from "../src/jira.ts";
import { createJiraTools, jiraToolApprovals } from "../src/jira-tools.ts";
import { qaProfile } from "../src/profile.ts";
import { QaSession } from "../src/session.ts";
import { FakeJira, PAT, testIssue } from "../test/fake-jira.ts";
import { makeTls } from "../test/tls.ts";

const windows = process.platform === "win32";
const results: { name: string; ok: boolean; detail: string }[] = [];

async function check(name: string, run: () => Promise<string | void> | string | void): Promise<void> {
	try {
		const detail = (await run()) ?? "";
		results.push({ name, ok: true, detail });
		console.log(`PASS: ${name}${detail ? ` (${detail})` : ""}`);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		results.push({ name, ok: false, detail });
		console.log(`FAIL: ${name}: ${detail.split("\n")[0]}`);
	}
}
const must = (condition: unknown, message: string): void => {
	if (!condition) throw new Error(message);
};
const info = (message: string): void => console.log(`INFO: ${message}`);

const root = realpathSync(mkdtempSync(join(tmpdir(), "somework-qa-smoke-")));
const workspaceRoot = join(root, "workspaces").replaceAll("\\", "/");
mkdirSync(join(workspaceRoot, ".home"), { recursive: true });
mkdirSync(join(workspaceRoot, ".tmp"), { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = join(workspaceRoot, ".tmp");

const PAGE = `<!doctype html><html><head><title>Smoke page</title></head><body><h1>Smoke</h1>
<label for="n">Name</label><input id="n" type="text">
<button onclick="document.getElementById('o').textContent='Hello '+document.getElementById('n').value">Greet</button>
<p id="o">nobody</p></body></html>`;
const SERVER = `import { createServer } from "node:http";\ncreateServer((q, r) => { r.setHeader("content-type", "text/html"); r.end(${JSON.stringify(PAGE)}); }).listen(Number(process.argv[2]), "127.0.0.1");\n`;

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as { port: number };
	await new Promise((resolve) => server.close(resolve));
	return port;
}
const answers = (url: string): Promise<boolean> => fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);

await check("node is 22.19+ and strips TypeScript", () => {
	const [major, minor] = process.versions.node.split(".").map(Number);
	must(major! > 22 || (major === 22 && minor! >= 19), `node ${process.version} is older than 22.19`);
	must((process.features as { typescript?: string | boolean }).typescript, "this node build has no TypeScript support (use the official build)");
	return process.version;
});

let bash: string | undefined;
await check(windows ? "Git for Windows bash and git are found" : "bash and git are found", () => {
	bash = windows ? chooseBash({ explicit: process.env.WINDOWS_BASH || undefined, candidates: bashCandidates(process.env), exists: existsSync }) : undefined;
	const git = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
	return `${bash ?? "/bin/bash"}; ${git}`;
});

const baseEnv = windows ? baseEnvironment({ root: workspaceRoot, host: process.env }) : { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: workspaceRoot };
if (windows) writeFileSync(join(workspaceRoot, ".home", ".gitconfig"), "[core]\n\tlongpaths = true\n\tautocrlf = false\n[credential]\n\thelper =\n");
const envFor = localEnvFactory({ root: workspaceRoot, shellPath: bash, baseEnv, maxOutputBytes: 64 * 1024, ...(windows ? { sweepUser: process.env.USERNAME } : {}) });
const ctx = BACKGROUND_CONTEXT;

await check("commands see only the base environment, and files outside the workspace root are refused", async () => {
	process.env.SOMEWORK_SMOKE_SECRET = "leak";
	let output = "";
	const result = await envFor(undefined).exec('echo "secret=[$SOMEWORK_SMOKE_SECRET]"', { onOutput: (text: string) => void (output += text) }, ctx);
	delete process.env.SOMEWORK_SMOKE_SECRET;
	must(result.ok && result.value.exitCode === 0 && output.includes("secret=[]"), `the service's environment leaked: ${output.trim()}`);
	const outside = join(root, "outside");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "secret.txt"), "secret");
	symlinkSync(outside, join(workspaceRoot, "escape"), "junction");
	for (const path of ["../outside/secret.txt", join(outside, "secret.txt"), "escape/secret.txt"]) must(!(await envFor(undefined).readTextFile(path, ctx)).ok, `${path} was readable`);
	return "environment clean; 3 reads refused";
});

// -- the application under test ------------------------------------------------------------------------------------------------------
const appDirectory = join(workspaceRoot, "app");
mkdirSync(appDirectory, { recursive: true });
writeFileSync(join(appDirectory, "server.mjs"), SERVER);
const port = await freePort();
const pageUrl = `http://127.0.0.1:${port}/`;
const appProfile: AppProfile = { start: `nohup node server.mjs ${port} > .qa-app.log 2>&1 < /dev/null & echo $! > .qa-app.pid`, health: [pageUrl], stop: "kill $(cat .qa-app.pid)", env: {}, startupTimeoutSeconds: 30 };

await check("an application profile starts the page, waits until it is healthy, and stops it", async () => {
	const runner = new AppRunner({ env: envFor(workspaceRoot) as never });
	const started = await runner.start(appProfile, appDirectory);
	must(started.ok, started.ok ? "" : started.reason);
	must(await answers(pageUrl), "the page does not answer");
	await runner.stop(appProfile, appDirectory, started.ok ? started.startedAtMs : Date.now());
	await new Promise((done) => setTimeout(done, 500));
	must(!(await answers(pageUrl)), "the page still answers after the stop");
	return "started, healthy, stopped";
});

// -- the browser ---------------------------------------------------------------------------------------------------------------------
const edgeLocations = windows
	? ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
	: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/usr/bin/microsoft-edge"];
const edge = edgeLocations.find((path) => existsSync(path));
let browserWorks = false;
if (!edge) {
	if (windows) await check("Microsoft Edge is installed", () => must(false, `not found in ${edgeLocations.join(" or ")}`));
	else info("Microsoft Edge is not installed on this machine: the browser checks use a stand-in");
} else {
	await check("Edge, driven headless by Playwright, fills and clicks by ref, takes a screenshot and records a real WebM video", async () => {
		const runner = new AppRunner({ env: envFor(workspaceRoot) as never });
		const started = await runner.start(appProfile, appDirectory);
		must(started.ok, started.ok ? "" : started.reason);
		const backend = await PlaywrightBackend.launch({ channel: "msedge", allowHosts: ["127.0.0.1", "localhost"], executablePath: edge });
		try {
			await backend.open(pageUrl);
			const ref = (text: string, name: string): string => /\[(e[0-9]+)\]/.exec(text.split("\n").find((line) => line.includes(name)) ?? "")?.[1] ?? must(false, `no ${name} in the outline:\n${text}`) as never;
			const outline = (await backend.snapshot()).text;
			await backend.videoStart(join(root, "smoke-videos"));
			await backend.fill(ref(outline, "textbox"), "world");
			await backend.click(ref(outline, "button"));
			await backend.wait({ text: "Hello world" });
			const video = await backend.videoStop();
			must(video && statSync(video).size > 1000 && readFileSync(video).subarray(0, 4).toString("hex") === "1a45dfa3", "the recording is not a WebM file");
			await backend.screenshot(join(root, "smoke.png"));
			must(readFileSync(join(root, "smoke.png")).subarray(1, 4).toString() === "PNG", "the screenshot is not a PNG");
			must((await backend.errors()).pageErrors.length === 0, "the page reported errors");
			browserWorks = true;
			return `${statSync(video!).size} bytes of video`;
		} finally {
			await backend.close();
			await runner.stop(appProfile, appDirectory, started.ok ? started.startedAtMs : Date.now());
		}
	});
}

// -- a whole verification --------------------------------------------------------------------------------------------------------------
const openssl = windows ? ["C:\\Program Files\\Git\\usr\\bin", "C:\\Program Files\\Git\\mingw64\\bin"].find((dir) => existsSync(join(dir, "openssl.exe"))) : "";
if (openssl) process.env.PATH = `${openssl}${windows ? ";" : ":"}${process.env.PATH ?? ""}`;
const opensslFound = spawnSync("openssl", ["version"]).status === 0;

await check("a scripted verification: application up, browser driven, video recorded, three approved ticket writes, application down", async () => {
	const { dir, remote } = makeRemote();
	const seed = join(dir, "seed");
	writeFileSync(join(seed, "server.mjs"), SERVER);
	sh(seed, "add", "-A");
	sh(seed, "commit", "-m", "app");
	sh(seed, "push", "origin", "HEAD:main");
	const sha = sh(remote, "rev-parse", "main").trim();

	const ticketSystem = opensslFound;
	let jira: FakeJira | undefined;
	let jiraClient: JiraClient | undefined;
	const session = new QaSession();
	let tools: ReturnType<typeof createJiraTools> | undefined;
	if (ticketSystem) {
		const tls = makeTls(join(root, "tls"));
		jira = await FakeJira.start(tls, [testIssue("QA-1")]);
		jiraClient = new JiraClient({ baseUrl: jira.url, token: PAT, pfx: tls.clientPfx, passphrase: tls.clientPassphrase, ca: tls.ca });
		tools = createJiraTools({ jira: jiraClient, session, pattern: /^QA-[0-9]+$/, testStatus: "Test", inProgressStatus: "In Progress", verifiedLabel: "AgentTested" });
	} else info("no openssl on this machine: the verification runs without the ticket system");

	const profile = qaProfile({ toolNames: tools?.toolNames, toolApprovals: tools ? jiraToolApprovals(session, "AgentTested", "In Progress") : undefined });
	const verificationPort = await freePort();
	const verificationUrl = `http://127.0.0.1:${verificationPort}/`;
	const profiles: Record<string, AppProfile> = { default: { ...appProfile, start: `nohup node server.mjs ${verificationPort} > .qa-app.log 2>&1 < /dev/null & echo $! > .qa-app.pid`, health: [verificationUrl] } };
	const useBrowser = async (): Promise<BrowserBackend> =>
		browserWorks
			? PlaywrightBackend.launch({ channel: "msedge", allowHosts: ["127.0.0.1", "localhost"], executablePath: edge })
			: new FakeBackend({ [verificationUrl]: { title: "Smoke page", lines: ["# Smoke", '[e1] textbox "Name"', '[e2] button "Greet"'] } });
	const uploaded: string[] = [];
	const client = { uploadArtifact: async (a: { filename: string }) => (uploaded.push(a.filename), { artifactId: `art_${a.filename}` }) };
	const hooks = createQaHooks({
		root: workspaceRoot,
		ticketPattern: /^QA-[0-9]+$/,
		profiles,
		session,
		appEnv: (cwd) => envFor(cwd) as never,
		browser: useBrowser,
		allowHosts: ["127.0.0.1", "localhost"],
		cliPath: fileURLToPath(new URL("../src/browser/cli.ts", import.meta.url)),
		extensions: tools ? [tools.extension] : undefined,
		hasTicketSystem: Boolean(tools),
		verifiedLabel: "AgentTested",
		client: client as never,
		secrets: [PAT],
	});
	const q = `"$(ls ${workspaceRoot}/.qa/*/qa)"`;
	const report = `\`\`\`json\n${JSON.stringify({ verdict: "verified", acceptanceChecks: [{ criterion: "the greeting shows the name", passed: true, evidence: "Hello world" }], fixtures: [], notes: "smoke" })}\n\`\`\``;
	const plan = [
		`bash:${q} open ${verificationUrl}`,
		`bash:${q} video-start`,
		`bash:${q} fill e1 world`,
		`bash:${q} click e2`,
		`bash:${q} wait --text "Hello world"`,
		`bash:${q} video-stop`,
		...(tools ? ['call:qa_record_verdict:{"verdict":"verified"}', 'call:jira_attach:{"file":"videos/qa-video-1.webm"}', 'call:jira_comment:{"body":"Verified by the smoke test."}', 'call:jira_add_label:{"label":"AgentTested"}'] : []),
		`final:${report}`,
	];
	const fake = scriptedModels(plan);
	const runtime = new PiDurableRuntime({ storagePath: join(root, "qa.sqlite"), models: fake.models, model: fake.model, env: envFor, policy: approvalPolicy([], profile.approvalPatterns, profile.toolApprovals), allowedTools: profile.allowedTools, extensions: hooks.extensions });
	await runtime.start();
	let approvals = 0;
	try {
		const handler = createHandler({ runtime: hooks.wrapRuntime!(runtime), envFor, session: { env: envFor(workspaceRoot), identity: { name: "Smoke", email: "smoke@test.invalid" } }, host: new FakeHost(), workspaceRoot, client: client as never, limits: { maxTokensCap: 1_000_000, maxMinutesCap: 10 }, metrics: new Metrics(), profile, hooks });
		const control = { signal: new AbortController().signal, stopReason: undefined, progress() {}, requestInput: async () => (approvals++, { approved: true }) };
		const job = { taskId: "smoke-qa", task: { conversationId: "smoke-qa" }, capability: { id: "qa.verify", version: "1" }, fencingToken: 1, runtimeInstanceId: "smoke", input: { ticket: "QA-1", repository: { url: remote, ref: sha }, budget: { maxTokens: 100_000, maxMinutes: 5 } } };
		const outcome = (await handler(job as never, control as never)) as { type: string; result?: Record<string, any> };
		must(outcome.type === "completed", `outcome ${JSON.stringify(outcome).slice(0, 400)}`);
		const result = outcome.result!;
		must(result.verdict === "verified", `verdict ${result.verdict}: ${result.notes}`);
		must(result.revision?.frontendSha === sha, "the checked-out revision is not reported");
		must(uploaded.some((name) => name.endsWith(".webm")), "no video was uploaded");
		if (jira) {
			const issue = jira.issues.get("QA-1")!;
			must(approvals === 3, `${approvals} approvals were asked, 3 expected`);
			must(issue.labels.includes("AgentTested") && issue.comments.length === 1 && issue.attachments.length === 1, "the ticket does not show the three writes");
			must(issue.status.name === "Test", "the ticket was moved");
		}
		must(!(await answers(verificationUrl)), "the application is still running after the verification");
		return `${browserWorks ? "real Edge" : "stand-in browser"}; ${jira ? "3 approved writes to the fake ticket system over mutual TLS" : "no ticket system"}`;
	} finally {
		await runtime.close();
		jiraClient?.close();
		await jira?.close();
	}
});

try {
	rmSync(root, { recursive: true, force: true });
} catch {
	// a surviving junction or open handle: the temporary directory is cleaned by the next run of the machine's temp cleanup
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((r) => r.name).join("; ")}` : ""}`);
process.exit(failed.length === 0 ? 0 : 1);
