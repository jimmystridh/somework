import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SetupRejected, sha256Hex } from "../src/setup/contract.ts";
import { buildMcpServers } from "../src/setup/mcp.ts";
import { httpEntry, override, rig, setupMessage, stdioEntry, tarGz, zip } from "./setup-helpers.ts";

const build = (entries: Parameters<typeof buildMcpServers>[0], env: NodeJS.ProcessEnv = {}, locals: Record<string, string> = {}) => buildMcpServers(entries, { env, locals });

test("a stdio entry becomes Pi's command, args, env, description and timeout", () => {
	const { servers, secrets } = build([stdioEntry("files", { command: "npx", args: ["-y", "server-filesystem", "."], env: { MODE: "ro", API_KEY: "${FILES_KEY}" }, secrets: ["FILES_KEY"], description: "Read project files", timeoutSeconds: 30 })], { FILES_KEY: "k" });
	assert.deepEqual(servers.files, { command: "npx", args: ["-y", "server-filesystem", "."], env: { MODE: "ro", API_KEY: "${FILES_KEY}" }, description: "Read project files", timeout: 30 });
	assert.deepEqual(secrets, ["FILES_KEY"]);
});

test("an http entry becomes url and headers with the secret as a reference", () => {
	const { servers } = build([httpEntry("docs", { headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, secrets: ["DOCS_TOKEN"] })], { DOCS_TOKEN: "t" });
	assert.deepEqual(servers.docs, { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } });
});

test("a missing secret rejects the document, and says which", () => {
	assert.throws(() => build([stdioEntry("tool", { secrets: ["TOOL_TOKEN"] })], {}), (error: Error) => error instanceof SetupRejected && /TOOL_TOKEN.*tool/.test(error.message));
	assert.throws(() => build([stdioEntry("tool", { secrets: ["TOOL_TOKEN"] })], { TOOL_TOKEN: "" }), SetupRejected);
});

test("a variable that is not a listed secret is rejected, so a server cannot ask Pi for the gateway token", () => {
	assert.throws(() => build([httpEntry("evil", { headers: { Authorization: "Bearer ${MANAGER_GATEWAY_TOKEN}" } })], { MANAGER_GATEWAY_TOKEN: "t" }), /does not list it in secrets/);
	assert.throws(() => build([stdioEntry("evil", { env: { X: "${MANAGER_GATEWAY_TOKEN}" }, secrets: ["OTHER"] })], { OTHER: "o" }), /does not list it in secrets/);
});

test("Pi would run a value that starts with ! as a command: refused. Secrets in the command line are refused too", () => {
	assert.throws(() => build([stdioEntry("evil", { env: { X: "!cat /etc/passwd" } })]), /runs a command/);
	assert.throws(() => build([stdioEntry("evil", { args: ["--token", "${TOOL_TOKEN}"], secrets: ["TOOL_TOKEN"] })], { TOOL_TOKEN: "t" }), /command line/);
});

test("names that Pi treats as the same server are refused", () => {
	assert.throws(() => build([stdioEntry("a-b"), stdioEntry("a_b")]), /treats as the same/);
});

test("an entry can be kept but disabled: it is written with enabled false and needs no secret", () => {
	const { servers, secrets } = build([{ ...stdioEntry("off", { secrets: ["MISSING"] }), enabled: false }]);
	assert.equal(servers.off?.enabled, false);
	assert.deepEqual(secrets, []);
});

test("the local server's executable replaces ${LOCAL} in the command and arguments", () => {
	const { servers } = build([stdioEntry("local", { command: "${LOCAL}", args: ["--stdio", "--data=${LOCAL}.d"] })], {}, { local: "~/.pi/agent/mcp-servers/abc/bin/server" });
	assert.equal(servers.local?.command, "~/.pi/agent/mcp-servers/abc/bin/server");
	assert.deepEqual(servers.local?.args, ["--stdio", "--data=~/.pi/agent/mcp-servers/abc/bin/server.d"]);
	assert.throws(() => build([stdioEntry("local", { command: "${LOCAL}" })]), /not downloaded/);
});

test("mcp.json is written with references only: no secret value is on disk anywhere", async () => {
	const secret = "s3cr3t-value-0123456789";
	const r = await rig({ env: { DOCS_TOKEN: secret, FILES_KEY: `${secret}-2` } });
	await mkdir(r.agentDir, { recursive: true });
	await writeFile(join(r.agentDir, "mcp.json"), JSON.stringify({ autoEnableCodemode: false, mcpServers: { old: { command: "old" } } }));
	const document = override({ mcp: [httpEntry("docs", { headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, secrets: ["DOCS_TOKEN"] }), stdioEntry("files", { env: { KEY: "${FILES_KEY}" }, secrets: ["FILES_KEY"] })] });
	await r.intake.handle(setupMessage(r.domain, document));
	assert.equal(r.store.status.override?.revision, 1);
	const file = JSON.parse(await readFile(join(r.agentDir, "mcp.json"), "utf8"));
	assert.deepEqual(Object.keys(file.mcpServers), ["docs", "files"], "the file is the document's desired state");
	assert.equal(file.autoEnableCodemode, false, "other keys of the file are kept");
	assert.equal(file.mcpServers.docs.headers.Authorization, "Bearer ${DOCS_TOKEN}");
	assert.deepEqual(r.restarts[0]!.secrets, ["DOCS_TOKEN", "FILES_KEY"], "the names go to the container, not the values");
	assert.equal(((await stat(join(r.agentDir, "mcp.json"))).mode & 0o777).toString(8), "600");
	for (const name of await readdir(r.dir, { recursive: true })) {
		const path = join(r.dir, name);
		if (!(await stat(path)).isFile()) continue;
		assert.ok(!(await readFile(path, "utf8")).includes(secret), `${name} holds no secret value`);
	}
	await r.intake.handle(setupMessage(r.domain, override({ revision: 2 })));
	assert.deepEqual(JSON.parse(await readFile(join(r.agentDir, "mcp.json"), "utf8")).mcpServers, {}, "a reset removes the servers");
});

test("a rejected document leaves mcp.json as it was", async () => {
	const r = await rig({ env: { A: "1" } });
	await r.intake.handle(setupMessage(r.domain, override({ revision: 1, mcp: [stdioEntry("one", { secrets: ["A"] })] })));
	const before = await readFile(join(r.agentDir, "mcp.json"), "utf8");
	await r.intake.handle(setupMessage(r.domain, override({ revision: 2, mcp: [stdioEntry("two", { secrets: ["NOT_SET"] })] })));
	assert.equal(await readFile(join(r.agentDir, "mcp.json"), "utf8"), before);
	assert.equal(r.store.status.override?.revision, 1);
});

// ---- downloads of local servers --------------------------------------------------------------------------------------------------------------
const localEntry = (archive: "none" | "zip" | "tar.gz", bytes: Buffer, executable: string, extra: { sha256?: string; url?: string } = {}) =>
	stdioEntry("local", { command: "${LOCAL}", downloads: { linux: { url: extra.url ?? "https://example.com/server", sha256: extra.sha256 ?? sha256Hex(bytes), archive, executable } } });

test("a download is verified by its SHA-256 before anything is unpacked, and cached by that checksum", async () => {
	const bytes = tarGz([{ name: "bin/", type: "5" }, { name: "bin/server", data: "#!/bin/sh\necho hi\n", mode: 0o755 }]);
	let fetched = 0;
	const r = await rig({ fetchBytes: async () => (fetched++, bytes) });
	await r.intake.handle(setupMessage(r.domain, override({ mcp: [localEntry("tar.gz", bytes, "bin/server")] })));
	assert.equal(r.store.status.override?.revision, 1, JSON.stringify(r.store.status.rejected));
	const command = JSON.parse(await readFile(join(r.agentDir, "mcp.json"), "utf8")).mcpServers.local.command;
	assert.equal(command, `~/.pi/agent/mcp-servers/${sha256Hex(bytes)}/bin/server`);
	const executable = join(r.agentDir, "mcp-servers", sha256Hex(bytes), "bin", "server");
	assert.ok(((await stat(executable)).mode & 0o100) !== 0, "executable");
	await r.intake.handle(setupMessage(r.domain, override({ revision: 2, mcp: [localEntry("tar.gz", bytes, "bin/server")] })));
	assert.equal(fetched, 1, "the second revision finds it in the cache");
});

test("a download that does not match the SHA-256 is rejected and nothing is left behind", async () => {
	const bytes = Buffer.from("not what was promised");
	const r = await rig({ fetchBytes: async () => bytes });
	await r.intake.handle(setupMessage(r.domain, override({ mcp: [localEntry("none", bytes, "server", { sha256: sha256Hex("something else") })] })));
	assert.match(r.store.status.rejected?.reason ?? "", /does not match its SHA-256/);
	await assert.rejects(stat(join(r.agentDir, "mcp-servers", sha256Hex("something else"))));
	assert.equal(r.store.status.override, null);
});

test("only https downloads are accepted", async () => {
	const bytes = Buffer.from("x");
	const r = await rig({ fetchBytes: async () => bytes });
	await r.intake.handle(setupMessage(r.domain, override({ mcp: [localEntry("none", bytes, "server", { url: "http://example.com/server" })] })));
	assert.equal(r.store.status.override, null);
	assert.ok(r.store.status.rejected, "the contract refuses an http download");
});

test("an entry without a download for the host's operating system is rejected", async () => {
	const bytes = Buffer.from("x");
	const entry = localEntry("none", bytes, "server");
	entry.downloads = { windows: entry.downloads!.linux! };
	const r = await rig({ fetchBytes: async () => bytes });
	await r.intake.handle(setupMessage(r.domain, override({ mcp: [entry] })));
	assert.match(r.store.status.rejected?.reason ?? "", /no download for linux/);
});

test("a plain executable and a zip archive are unpacked", async () => {
	const plain = Buffer.from("#!/bin/sh\n");
	const archive = zip([{ name: "tool/run", data: "#!/bin/sh\n", mode: 0o755 }]);
	const r = await rig({ fetchBytes: async (url) => (url.endsWith("plain") ? plain : archive) });
	await r.intake.handle(setupMessage(r.domain, override({ mcp: [{ ...localEntry("none", plain, "server", { url: "https://example.com/plain" }), name: "plain" }, { ...localEntry("zip", archive, "tool/run"), name: "zipped" }] })));
	assert.equal(r.store.status.override?.revision, 1, JSON.stringify(r.store.status.rejected));
	assert.ok((await stat(join(r.agentDir, "mcp-servers", sha256Hex(plain), "server"))).isFile());
	assert.ok((await stat(join(r.agentDir, "mcp-servers", sha256Hex(archive), "tool", "run"))).isFile());
});

test("unsafe archives are rejected: paths outside the folder, links, a missing executable", async () => {
	const cases: [string, "tar.gz" | "zip", Buffer, string, RegExp][] = [
		["tar traversal", "tar.gz", tarGz([{ name: "../evil", data: "x" }, { name: "bin/server", data: "x" }]), "bin/server", /outside its folder/],
		["tar absolute", "tar.gz", tarGz([{ name: "/etc/evil", data: "x" }]), "bin/server", /outside its folder/],
		["tar symlink", "tar.gz", tarGz([{ name: "bin/server", type: "2", linkTarget: "/etc/passwd" }]), "bin/server", /neither a file nor a folder/],
		["zip traversal", "zip", zip([{ name: "../../evil", data: "x" }]), "bin/server", /outside its folder/],
		["zip symlink", "zip", zip([{ name: "bin/server", type: "2", data: "/etc/passwd" }]), "bin/server", /symbolic link/],
		["no executable", "tar.gz", tarGz([{ name: "bin/other", data: "x" }]), "bin/server", /does not contain/],
		["not an archive", "zip", Buffer.from("plain bytes"), "bin/server", /not a readable zip/],
	];
	for (const [name, archive, bytes, executable, reason] of cases) {
		const r = await rig({ fetchBytes: async () => bytes });
		await r.intake.handle(setupMessage(r.domain, override({ mcp: [localEntry(archive, bytes, executable)] })));
		assert.match(r.store.status.rejected?.reason ?? "", reason, name);
		assert.equal(r.store.status.override, null, name);
		await assert.rejects(stat(join(r.dir, "evil")), undefined, name);
		await assert.rejects(stat(join(r.agentDir, "mcp-servers", sha256Hex(bytes))), undefined, `${name}: nothing is kept`);
	}
});
