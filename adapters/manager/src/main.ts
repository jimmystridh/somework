import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Identity, SomeWorkClient } from "@somework/sdk";
import { TelegramBridge } from "./bridge.ts";
import { loadConfig } from "./config.ts";
import { ChatSessions } from "./chat.ts";
import { Controls } from "./controls.ts";
import { HostControls, loadHostConfig } from "./host.ts";
import { RestDomain } from "./domain.ts";
import { ensureJobSubscription, EventIntake } from "./event-intake.ts";
import { createGateway } from "./gateway.ts";
import { InboxReader, Notifications, PollingFeed, WakeFeed } from "./notifier.ts";
import { createHealthServer } from "./health.ts";
import { piArguments, PiProcess } from "./pi-process.ts";
import { ApprovalGrants, ApprovalRules } from "./policy.ts";
import { ManagerService } from "./service.ts";
import { SetupApplier } from "./setup/apply.ts";
import { isSetupMessage, SetupIntake } from "./setup/intake.ts";
import { describeManager } from "./setup/profile.ts";
import { SetupStore } from "./setup/store.ts";
import { fileSaver, loadState } from "./state.ts";
import { telegramApi } from "./telegram.ts";
import { startTelemetry } from "./telemetry.ts";

const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));

async function gatewayToken(path: string): Promise<string> {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch {
		const token = randomBytes(32).toString("hex");
		await writeFile(path, `${token}\n`, { mode: 0o600 });
		return token;
	}
}

async function main(): Promise<void> {
	process.umask(0o077);
	const config = loadConfig();
	const token = (await readFile(join(config.configDir, "bot-token"), "utf8")).trim();
	if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("Invalid bot credential");
	const statePath = join(config.configDir, "state.json");
	const state = await loadState(statePath);
	const save = fileSaver(statePath);
	const api = telegramApi(token);
	const bot = await api("getMe");
	if (bot.id !== state.botId) throw new Error("Bot identity mismatch");
	if ((await api("getWebhookInfo")).url) throw new Error("Existing webhook must be reviewed before replacing it");

	const client = new SomeWorkClient({ baseUrl: config.somework.url, identity: Identity.fromFile(config.somework.keyFile), caFile: config.somework.caFile, requireTls: true });
	const domain = new RestDomain(client);
	// A registered runtime with a heartbeat lets the operator views (and the fleet dashboard) show the manager as alive instead of unknown.
	await client.registerRuntime({ sdk: "@somework/manager" }).catch((error: unknown) => log("runtime_register_failed", { error: String(error).slice(0, 160) }));
	const runtimeHeartbeat = setInterval(() => void client.runtimeHeartbeat().catch(() => {}), 10_000);
	runtimeHeartbeat.unref();
	const gatewayTokenValue = await gatewayToken(join(config.configDir, "gateway-token"));

	const notifications = new Notifications();
	const rules = new ApprovalRules();
	const grants = new ApprovalGrants();
	const store = new SetupStore(config.setup.dir);
	const applier = new SetupApplier({
		store,
		rules,
		agentDir: config.setup.piAgentDir,
		containerAgentDir: config.setup.piAgentDirInContainer,
		os: config.setup.os,
		env: process.env,
		restart: (launch) => rpc.requestRestart(launch),
	});
	const wantedLaunch = await applier.restore();
	const intake = new SetupIntake({ domain, applier, store, log });
	const inbox = new InboxReader(domain, notifications, { claims: isSetupMessage, handle: (message) => intake.handle(message) });

	const piEnv = { ...process.env, MANAGER_GATEWAY_URL: config.gateway.urlForPi, MANAGER_GATEWAY_TOKEN: gatewayTokenValue };
	const rpc: PiProcess = new PiProcess({
		start: (launch) => spawn("/usr/bin/docker", piArguments(config.composeFiles, state.sessionPath!, launch), { stdio: ["pipe", "pipe", "pipe"], env: piEnv }),
		stopContainer: () => new Promise<void>((resolve) => spawn("/usr/bin/docker", ["stop", "--timeout", "15", "pi-demo"], { stdio: "ignore" }).once("exit", () => resolve()).once("error", () => resolve())),
		isIdle: async () => !bridge.active && !(await rpc.command("get_state", {}, 8000)).isStreaming,
		sessionId: state.sessionId!,
		fallback: () => applier.baselineLaunch(),
		onUnexpectedExit: () => {
			if (stopping) return;
			console.error("Pi process exited");
			process.exitCode = 1;
			shutdown();
		},
		onLaunched: (result) => {
			if (result.failed) void store.withdrawOverride(`Pi did not start with this setup (${result.failed.reason}); it runs without it`).catch(() => {});
		},
		log,
	});
	const bridge = new TelegramBridge({ state, api, rpc, save, notifications });
	const host = config.hostControl ? new HostControls(loadHostConfig(config.hostControl)) : undefined;
	const controls = new Controls({
		domain,
		config: config.controls,
		grants: { store: grants, ttlMs: config.policy.approvalTtlMs },
		...(host ? { host } : {}),
		state,
		save,
		pendingQuestions: () => service.pendingRequests() + Object.keys(state.chatApprovals ?? {}).length,
	});
	const chats = new ChatSessions({ domain, owner: bridge, state, save, knownAgents: () => service.knownAgentIds() });
	const service: ManagerService = new ManagerService({ domain, policy: config.policy, owner: bridge, controls, chats, approvals: { rules, grants } });
	const eventIntake = new EventIntake({ domain, owner: bridge, state, save, config: config.events, digest: () => controls.digest(), log });
	bridge.service = service;
	await ensureJobSubscription(domain, state, save, log);
	const gateway = createGateway({ service, token: gatewayTokenValue, log });

	const controller = new AbortController();
	let stopping = false;
	let telemetry: ReturnType<typeof startTelemetry> | undefined;
	const health = config.health.port > 0 ? createHealthServer({ profile: () => profile() }) : undefined;
	const shutdown = () => {
		if (stopping) return;
		stopping = true;
		telemetry?.stop();
		clearInterval(runtimeHeartbeat);
		void client.endRuntime().catch(() => {});
		controller.abort();
		gateway.close();
		health?.close();
		void rpc.stop();
	};
	const profile = async () =>
		describeManager({
			agentId: domain.selfId,
			override: store.status.override ? store.override : undefined,
			status: store.status,
			rules,
			model: await rpc.command("get_state", {}, 3000).then((current) => (current.model ? { provider: current.model.provider, modelId: current.model.id } : rpc.launch.model), () => rpc.launch.model),
			restartPending: rpc.restartPending,
		});
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);

	try {
		const started = await rpc.start(wantedLaunch);
		if (started.failed) await store.withdrawOverride(`Pi did not start with the saved setup (${started.failed.reason}); it runs without it`);
		const current = await rpc.command("get_state", {}, 60_000);
		if (!started.launch.model && current.model) await store.rememberBaselineModel({ provider: current.model.provider, modelId: current.model.id });
		await new Promise<void>((resolve, reject) => {
			gateway.once("error", reject);
			gateway.listen(config.gateway.port, config.gateway.bind, resolve);
		});
		if (health) {
			await new Promise<void>((resolve, reject) => {
				health.once("error", reject);
				health.listen(config.health.port, config.health.bind, resolve);
			});
		}
		telemetry = startTelemetry(rpc, config.telemetryPath);
		rpc.onTelemetryEvent = telemetry.observe;
		const feed =
			config.feed.mode === "polling"
				? new PollingFeed(inbox, config.feed, log)
				: new WakeFeed(client, inbox, { sweepEveryMs: config.feed.sweepEveryMs, wake: { logger: (level, message, fields) => log(`wake_${level}`, { message, ...fields }) } }, log);
		void feed.run(controller.signal);
		const every = (name: string, ms: number, step: () => Promise<unknown>) => {
			const timer = setInterval(() => void step().catch((error: unknown) => log(`${name}_failed`, { error: error instanceof Error ? error.message.slice(0, 160) : "error" })), ms);
			timer.unref();
			return timer;
		};
		const timers = [
			every("events_poll", config.events.pollMs, () => eventIntake.poll()),
			every("notices_report", 60_000, () => bridge.reportSuppressed()),
			every("chat_sweep", 20_000, () => chats.sweep()),
		];
		log("manager_ready", { bot: bot.username, owner: state.allowedUserId ? "paired" : "awaiting secure pairing", gateway: `${config.gateway.bind}:${config.gateway.port}`, agent: domain.selfId });
		while (!stopping) {
			try {
				const updates = await api("getUpdates", { offset: state.lastUpdateId === undefined ? undefined : state.lastUpdateId + 1, limit: 20, timeout: 30, allowed_updates: ["message", "callback_query"] }, controller.signal);
				for (const update of updates) {
					if (stopping) break;
					state.lastUpdateId = update.update_id;
					await save(state);
					try {
						await bridge.handleUpdate(update);
					} catch {
						console.error("Telegram message processing failed");
					}
				}
			} catch {
				if (stopping) break;
				console.error("Telegram polling failed; retrying");
				await new Promise((resolve) => setTimeout(resolve, 10_000));
			}
		}
		for (const timer of timers) clearInterval(timer);
		clearInterval(bridge.typingTimer);
		await bridge.delivery;
	} finally {
		shutdown();
	}
}

main().catch((error) => {
	console.error(`Manager startup failed: ${error instanceof Error ? error.message.slice(0, 200) : "error"}`);
	process.exitCode = 1;
});
