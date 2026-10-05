import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import { err, ExecutionError, FileError, ok, type ExecutionEnv, type FileInfo, type Result, type ShellExecOptions, type ShellExecResult, type TextLineReader } from "@earendil-works/pi-durable/env";

export interface RemoteEnvOptions {
	baseUrl: string;
	token: string;
	cwd: string;
	/** Equal ids see the same files: one id per container. */
	id: string;
	caPem?: string;
}

type Wire = { ok: true; value: any } | { ok: false; error: { name?: string; code?: string; message?: string; path?: string; spillPath?: string } };
type Transport = { transportError: string };

function post(options: RemoteEnvOptions, path: string, body: unknown, signal: AbortSignal, onLine?: (line: any) => void): Promise<any | Transport> {
	return new Promise((resolve) => {
		const url = new URL(path, options.baseUrl);
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const payload = JSON.stringify(body);
		const req = send(url, { method: "POST", signal, ...(options.caPem ? { ca: options.caPem } : {}), headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } }, (res) => {
			let buffered = "";
			let last: any;
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				buffered += chunk;
				for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					if (line) (last = JSON.parse(line)), onLine?.(last);
				}
			});
			res.on("error", (e) => resolve({ transportError: e.message }));
			res.on("end", () => {
				if (res.statusCode !== 200) return resolve({ transportError: `sandbox answered ${res.statusCode}: ${buffered}`.slice(0, 300) });
				if (onLine) return resolve(last ?? { transportError: "the sandbox closed the stream without a result" });
				try {
					resolve(JSON.parse(buffered));
				} catch {
					resolve({ transportError: "unreadable sandbox response" });
				}
			});
		});
		req.on("error", (e) => resolve({ transportError: e.message }));
		req.end(payload);
	});
}

const isTransport = (value: unknown): value is Transport => typeof value === "object" && value !== null && "transportError" in value;

/** Pi's `ExecutionEnv` over HTTP to the sandbox container: tools run there, the harness keeps the credentials. */
export class RemoteExecutionEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	readonly #options: RemoteEnvOptions;

	constructor(options: RemoteEnvOptions) {
		this.id = options.id;
		this.cwd = options.cwd;
		this.#options = options;
	}

	/** Runs one request; cancelling `context` aborts the HTTP request, which makes the sandbox kill the command's process tree. */
	async #call(path: string, body: unknown, context: Context, onLine?: (line: any) => void): Promise<{ aborted: true } | { transport: string } | { value: any }> {
		const abort = new AbortController();
		const request = post(this.#options, path, { cwd: this.cwd, ...(body as object) }, abort.signal, onLine);
		try {
			const value = await awaitWithContext(request, context);
			return isTransport(value) ? { transport: value.transportError } : { value };
		} catch {
			abort.abort();
			return { aborted: true };
		}
	}

	async #fs<T>(op: string, args: Record<string, unknown>, context: Context, map: (value: any) => T = (v) => v): Promise<Result<T, FileError>> {
		const outcome = await this.#call("/fs", { op, args }, context);
		if ("aborted" in outcome) return err(new FileError("aborted", "aborted", typeof args.path === "string" ? args.path : undefined));
		if ("transport" in outcome) return err(new FileError("unknown", `sandbox unreachable: ${outcome.transport}`));
		const wire = outcome.value as Wire;
		if (wire.ok) return ok(map(wire.value));
		return err(new FileError((wire.error.code as any) ?? "unknown", wire.error.message ?? "file operation failed", wire.error.path));
	}

	absolutePath(path: string, context: Context) { return this.#fs<string>("absolutePath", { path }, context); }
	joinPath(parts: string[], context: Context) { return this.#fs<string>("joinPath", { parts }, context); }
	readTextFile(path: string, context: Context) { return this.#fs<string>("readTextFile", { path }, context); }
	readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) { return this.#fs<string[]>("readTextLines", { path, options }, context); }
	readBinaryFile(path: string, context: Context) { return this.#fs<Uint8Array>("readBinaryFile", { path }, context, (v) => new Uint8Array(Buffer.from(v.__b64, "base64"))); }
	writeFile(path: string, content: string | Uint8Array, context: Context) { return this.#fs<void>("writeFile", { path, content: encode(content) }, context, () => undefined); }
	appendFile(path: string, content: string | Uint8Array, context: Context) { return this.#fs<void>("appendFile", { path, content: encode(content) }, context, () => undefined); }
	truncateFile(path: string, size: number, context: Context) { return this.#fs<void>("truncateFile", { path, size }, context, () => undefined); }
	flushFile(path: string, context: Context) { return this.#fs<void>("flushFile", { path }, context, () => undefined); }
	renameFile(source: string, destination: string, context: Context) { return this.#fs<void>("renameFile", { source, destination }, context, () => undefined); }
	fileInfo(path: string, context: Context) { return this.#fs<FileInfo>("fileInfo", { path }, context); }
	listDir(path: string, context: Context) { return this.#fs<FileInfo[]>("listDir", { path }, context); }
	canonicalPath(path: string, context: Context) { return this.#fs<string>("canonicalPath", { path }, context); }
	exists(path: string, context: Context) { return this.#fs<boolean>("exists", { path }, context); }
	createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) { return this.#fs<void>("createDir", { path, options }, context, () => undefined); }
	remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) { return this.#fs<void>("remove", { path, options }, context, () => undefined); }
	createTempDir(prefix: string | undefined, context: Context) { return this.#fs<string>("createTempDir", { prefix }, context); }
	createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) { return this.#fs<string>("createTempFile", { options }, context); }

	/** Whole-file read then split: coding tools read files that fit in memory. */
	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text as Result<never, FileError>;
		const lines = text.value.split(/(?<=\n)/);
		let next = 0;
		return ok({
			readLine: async () => {
				const line = lines[next++];
				return ok(line === undefined ? undefined : { text: line.replace(/\r?\n$/, ""), terminated: line.endsWith("\n") });
			},
			close: async () => {},
		});
	}

	async exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		const { onOutput, ...wireOptions } = options ?? {};
		const outcome = await this.#call("/exec", { command, ...wireOptions, cwd: wireOptions.cwd ?? this.cwd }, context, (line) => {
			if (line.t === "out") onOutput?.(line.d, context);
		});
		if ("aborted" in outcome) return err(new ExecutionError("aborted", "aborted"));
		if ("transport" in outcome) return err(new ExecutionError("spawn_error", `sandbox unreachable: ${outcome.transport}`));
		const wire = outcome.value as Wire & { t?: string };
		if (wire.ok) return ok(wire.value as ShellExecResult);
		const error = new ExecutionError((wire.error.code as any) ?? "unknown", wire.error.message ?? "command failed");
		error.spillPath = wire.error.spillPath;
		return err(error);
	}

	async cleanup(_context: Context): Promise<void> {}
}

function encode(content: string | Uint8Array): string | { __b64: string } {
	return typeof content === "string" ? content : { __b64: Buffer.from(content).toString("base64") };
}
