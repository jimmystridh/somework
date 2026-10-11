import { SYSTEM_PROMPT } from "./prompt.ts";
import { ChildPiRpc, type PiChild, type PiRpc } from "./rpc.ts";

/** What operators can change about how Pi is started (ADR 0004); everything else about the process is fixed. */
export interface PiLaunch {
	/** Appended to the built-in prompt after it, so it can add to the rules and never take one away. */
	addendum?: string;
	model?: { provider: string; modelId: string };
	/** The container's Pi starts with `--no-extensions --no-skills`: its built-in MCP support and the library skills have to be asked for by name. */
	mcp?: boolean;
	skillsDir?: string;
	/** Environment variables Pi's `${NAME}` expansion needs: passed from the Manager's environment into the container by name. */
	secrets: string[];
}

export const noOperatorSetup: PiLaunch = { secrets: [] };

export const addendumPrompt = (revision: number, instructions: string): string =>
	`Operator instructions from Operations (revision ${revision}). They add to the rules above and never replace them; where they conflict, the rules above win.\n\n${instructions}`;

/** The `docker compose run` arguments of the `pi-demo` container; the gateway token and the secrets go in by name, never by value. */
export function piArguments(composeFiles: string[], sessionPath: string, launch: PiLaunch): string[] {
	return [
		"compose", ...composeFiles.flatMap((file) => ["-f", file]),
		"run", "--rm", "--no-deps", "-T", "--name", "pi-demo",
		"-e", "MANAGER_GATEWAY_URL", "-e", "MANAGER_GATEWAY_TOKEN",
		...launch.secrets.flatMap((name) => ["-e", name]),
		"pi",
		"-e", "/opt/manager/somework-tools.ts",
		...(launch.mcp ? ["-e", "builtin:mcp"] : []),
		...(launch.skillsDir ? ["--skill", launch.skillsDir] : []),
		"--mode", "rpc", "--session", sessionPath,
		"--append-system-prompt", SYSTEM_PROMPT,
		...(launch.addendum ? ["--append-system-prompt", launch.addendum] : []),
		...(launch.model ? ["--model", `${launch.model.provider}/${launch.model.modelId}`] : []),
	];
}

export interface PiProcessOptions {
	start: (launch: PiLaunch) => PiChild;
	/** Removes the container of an earlier child, which holds the fixed name `pi-demo`. */
	stopContainer?: () => Promise<void>;
	/** True when no run is going or about to start; asked before every restart. */
	isIdle: () => Promise<boolean>;
	/** The session Pi must come back with: the conversation goes on across a restart. */
	sessionId: string;
	/** What runs when the wanted setup does not start. */
	fallback?: () => PiLaunch;
	/** Called with every child that stops without the Manager having asked for it. */
	onUnexpectedExit: () => void;
	/** After a restart: which launch is in effect, and why not the wanted one. */
	onLaunched?: (result: LaunchResult) => void;
	log?: (event: string, fields?: Record<string, unknown>) => void;
	pollMs?: number;
	stopAfterMs?: number;
}

export interface LaunchResult {
	launch: PiLaunch;
	/** Set when the wanted launch did not start and the fallback runs instead. */
	failed?: { wanted: PiLaunch; reason: string };
}

/**
 * The Pi child process behind one stable `PiRpc`. A new setup (prompt addendum, model, MCP servers, skills) reaches Pi only through a new
 * process, because Pi reads those at start and takes none of them through RPC; the restart waits until no run is going, so a run always finishes with the setup
 * it began with. Commands that arrive during the few seconds of a restart wait for the new process.
 */
export class PiProcess implements PiRpc {
	launch: PiLaunch = noOperatorSetup;
	readonly #options: PiProcessOptions;
	#child: PiChild | undefined;
	#rpc: ChildPiRpc | undefined;
	#onEvent: (event: any) => void = () => {};
	#onTelemetryEvent: (event: any) => void = () => {};
	readonly #asked = new WeakSet<PiChild>();
	#starting: PiChild | undefined;
	#holding: Promise<void> | undefined;
	#wanted: PiLaunch | undefined;
	#checking = false;
	#timer: NodeJS.Timeout | undefined;

	constructor(options: PiProcessOptions) {
		this.#options = options;
	}

	get onEvent(): (event: any) => void {
		return this.#onEvent;
	}

	set onEvent(handler: (event: any) => void) {
		this.#onEvent = handler;
	}

	get onTelemetryEvent(): (event: any) => void {
		return this.#onTelemetryEvent;
	}

	set onTelemetryEvent(handler: (event: any) => void) {
		this.#onTelemetryEvent = handler;
	}

	async command(type: string, fields: Record<string, unknown> = {}, timeout?: number): Promise<any> {
		while (this.#holding) await this.#holding;
		if (!this.#rpc) throw new Error("Pi is not running");
		return this.#rpc.command(type, fields, timeout);
	}

	/** The first start: not waiting for anything, and falling back at once when the wanted launch does not come up. */
	async start(wanted: PiLaunch): Promise<LaunchResult> {
		return this.#launch(wanted);
	}

	/** Restarts with `wanted` as soon as Pi is idle; a newer request replaces one that is still waiting. */
	requestRestart(wanted: PiLaunch): void {
		this.#wanted = wanted;
		this.#timer ??= setInterval(() => void this.#restartIfIdle(), this.#options.pollMs ?? 2000).unref();
		void this.#restartIfIdle();
	}

	get restartPending(): boolean {
		return this.#wanted !== undefined;
	}

	async stop(): Promise<void> {
		clearInterval(this.#timer);
		this.#timer = undefined;
		this.#wanted = undefined;
		const child = this.#child;
		this.#child = undefined;
		if (child) await this.#terminate(child);
	}

	async #restartIfIdle(): Promise<void> {
		if (this.#checking || !this.#wanted || this.#holding) return;
		this.#checking = true;
		try {
			if (!(await this.#options.isIdle())) return;
			const wanted = this.#wanted;
			if (!wanted) return;
			this.#wanted = undefined;
			clearInterval(this.#timer);
			this.#timer = undefined;
			let release!: () => void;
			this.#holding = new Promise<void>((resolve) => (release = resolve));
			try {
				const previous = this.#child;
				this.#child = undefined;
				if (previous) await this.#terminate(previous);
				this.#options.onLaunched?.(await this.#launch(wanted));
			} finally {
				this.#holding = undefined;
				release();
			}
		} catch (error) {
			this.#options.log?.("pi_restart_failed", { error: error instanceof Error ? error.message.slice(0, 160) : "error" });
			this.#options.onUnexpectedExit();
		} finally {
			this.#checking = false;
		}
	}

	async #launch(wanted: PiLaunch): Promise<LaunchResult> {
		try {
			await this.#spawn(wanted);
			return { launch: wanted };
		} catch (error) {
			const reason = error instanceof Error ? error.message.slice(0, 200) : "error";
			const fallback = this.#options.fallback?.();
			if (!fallback) throw error;
			this.#options.log?.("pi_launch_failed", { reason });
			const failed = this.#child;
			this.#child = undefined;
			if (failed) await this.#terminate(failed);
			await this.#spawn(fallback);
			return { launch: fallback, failed: { wanted, reason } };
		}
	}

	async #spawn(launch: PiLaunch): Promise<void> {
		const child = this.#options.start(launch);
		const rpc = new ChildPiRpc(child);
		rpc.onEvent = (event) => this.#onEvent(event);
		rpc.onTelemetryEvent = (event) => this.#onTelemetryEvent(event);
		child.on("exit", () => {
			if (this.#asked.has(child) || this.#starting === child || this.#child !== child) return;
			this.#options.onUnexpectedExit();
		});
		this.#child = child;
		this.#rpc = rpc;
		this.#starting = child;
		try {
			const state = await rpc.command("get_state", {}, 60_000);
			if (state.sessionId !== this.#options.sessionId || state.isStreaming) throw new Error("Unexpected Pi session");
		} finally {
			this.#starting = undefined;
		}
		this.launch = launch;
	}

	async #terminate(child: PiChild): Promise<void> {
		this.#asked.add(child);
		const gone = new Promise<void>((resolve) => child.on("exit", () => resolve()));
		child.stdin.end();
		child.kill("SIGTERM");
		const kill = setTimeout(() => child.kill("SIGKILL"), this.#options.stopAfterMs ?? 15_000);
		await Promise.race([gone, new Promise<void>((resolve) => setTimeout(resolve, (this.#options.stopAfterMs ?? 15_000) + 5000).unref())]);
		clearTimeout(kill);
		await this.#options.stopContainer?.().catch(() => {});
	}
}
