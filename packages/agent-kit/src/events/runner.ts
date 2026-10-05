import { createHash, randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { redactText } from "./redact.ts";
import { DECISION_MARKER, RUNNER_SOURCE } from "./runner-script.ts";
import type { HandlerInput } from "./types.ts";

export type RunFailure = "timeout" | "memory" | "output" | "error" | "unavailable";

export type RunResult = { ok: true; decision: unknown; ms: number; stderr: string } | { ok: false; kind: RunFailure; message: string; ms: number; stderr: string };

export interface RunnerOptions {
	/** The agent's own execution environment (container sandbox, or the Windows confined environment). */
	env: () => ExecutionEnv;
	/** A directory inside the environment's workspace root where runner files are written. */
	dir: string;
	timeoutSeconds: number;
	memoryMb: number;
	maxOutputBytes: number;
	fetchHosts: string[];
}

const ctx = BACKGROUND_CONTEXT;
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);
const STDERR_TAIL = 2000;

/**
 * Runs handlers as child processes inside the agent's own sandbox, through the same `ExecutionEnv` the agent's tools use, so the handler
 * has exactly the files and network the tools have and no more: the environment strips the service's variables (`inheritEnv: false`),
 * kills the process tree on timeout, and the runner receives only what is listed here. The service's credentials never reach the sandbox.
 */
export class HandlerRunner {
	readonly #options: RunnerOptions;
	readonly #written = new Set<string>();

	constructor(options: RunnerOptions) {
		this.#options = options;
	}

	async #ensure(env: ExecutionEnv, path: string, content: string): Promise<string | undefined> {
		const key = `${env.id}\u0000${path}`;
		if (this.#written.has(key)) return undefined;
		const written = await env.writeFile(path, content, ctx);
		if (!written.ok) return `cannot write ${path}: ${written.error.message}`;
		this.#written.add(key);
		return undefined;
	}

	async run(handler: { name: string; hash: string; source: string }, input: HandlerInput): Promise<RunResult> {
		const started = Date.now();
		const fail = (kind: RunFailure, message: string, stderr = ""): RunResult => ({ ok: false, kind, message, ms: Date.now() - started, stderr: redactText(stderr).slice(-STDERR_TAIL) });
		const env = this.#options.env();
		const dir = this.#options.dir;
		const made = await env.createDir(dir, { recursive: true }, ctx);
		if (!made.ok) return fail("unavailable", `the sandbox is not reachable: ${made.error.message}`);
		const runner = `${dir}/runner-${sha(RUNNER_SOURCE)}.mjs`;
		const file = `${dir}/h-${handler.name}-${handler.hash.slice(0, 12)}.mjs`;
		const inputPath = `${dir}/in-${randomUUID()}.json`;
		for (const problem of [await this.#ensure(env, runner, RUNNER_SOURCE), await this.#ensure(env, file, handler.source)]) if (problem) return fail("unavailable", problem);
		const wrote = await env.writeFile(inputPath, JSON.stringify(input), ctx);
		if (!wrote.ok) return fail("unavailable", `cannot write the handler input: ${wrote.error.message}`);

		let stdout = "";
		let stderr = "";
		let overflow = false;
		const diagnostics = (): string => (stderr !== "" ? stderr : stdout.split("\n").filter((line) => !line.startsWith(DECISION_MARKER)).join("\n"));
		const cancel = withCancel(ctx);
		const limit = this.#options.maxOutputBytes * 2;
		try {
			const result = await env.exec(
				`node --max-old-space-size=${Math.max(16, Math.floor(this.#options.memoryMb))} ${quote(runner)} ${quote(file)} ${quote(inputPath)}`,
				{
					cwd: dir,
					inheritEnv: false,
					env: { HANDLER_FETCH_HOSTS: this.#options.fetchHosts.join(","), HANDLER_MAX_OUTPUT: String(this.#options.maxOutputBytes) },
					timeout: Math.max(1, Math.ceil(this.#options.timeoutSeconds)),
					onOutput: (text, _context, info) => {
						if (info?.stream === "stderr") return void (stderr = (stderr + text).slice(-STDERR_TAIL * 2));
						if ((stdout += text).length > limit) {
							overflow = true;
							cancel.cancel("handler output limit");
						}
					},
				},
				cancel.context,
			);
			if (overflow) return fail("output", `the handler printed more than ${this.#options.maxOutputBytes} bytes`, diagnostics());
			if (!result.ok) {
				if (result.error.code === "timeout") return fail("timeout", `the handler ran longer than ${this.#options.timeoutSeconds} s and was stopped`, diagnostics());
				return fail(result.error.code === "aborted" ? "error" : "unavailable", `the handler could not run: ${result.error.message}`, diagnostics());
			}
			if (result.value.exitCode === 3) return fail("output", `the handler's decision is larger than ${this.#options.maxOutputBytes} bytes`, diagnostics());
			if (result.value.exitCode === 134 || /heap out of memory|allocation failed/i.test(diagnostics())) return fail("memory", `the handler used more than ${this.#options.memoryMb} MB`, diagnostics());
			if (result.value.exitCode !== 0) return fail("error", `the handler exited with code ${result.value.exitCode}`, diagnostics());
			const line = stdout.split("\n").findLast((candidate) => candidate.startsWith(DECISION_MARKER));
			if (line === undefined) return fail("error", "the handler produced no decision", diagnostics());
			try {
				return { ok: true, decision: JSON.parse(line.slice(DECISION_MARKER.length)), ms: Date.now() - started, stderr: redactText(diagnostics()).slice(-STDERR_TAIL) };
			} catch {
				return fail("error", "the handler's decision is not valid JSON", diagnostics());
			}
		} finally {
			await env.remove(inputPath, { force: true }, ctx).catch(() => undefined);
		}
	}
}
