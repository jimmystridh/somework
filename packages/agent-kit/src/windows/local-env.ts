import { realpath } from "node:fs";
import { posix, win32 } from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, ExecutionError, FileError, ok, type BinaryReader, type DirReader, type ExecutionEnv, type FileInfo, type FileWatcher, type Result, type ShellExecOptions, type ShellExecResult, type TextLineReader, type WatchChange, type WatchTarget } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ConfinementError, isInside, nativeFlavour, resolveInside, type Flavour } from "./paths.ts";
import { sweepLeftovers, type SweepOptions } from "./sweep.ts";

export interface LocalEnvOptions {
	/** Workspace root: the only part of the disk the model's file tools and the job's commands start in. */
	root: string;
	/** Working directory of this environment (default: the root). Must be inside the root. */
	cwd?: string;
	/** Git for Windows' `bash.exe` (see `chooseBash`). Unset lets pi-durable look for it. */
	shellPath?: string;
	/** The whole environment of every command; the service's own environment is never inherited. */
	baseEnv: Record<string, string>;
	flavour?: Flavour;
	/** Output delivered to `onOutput` per command; the rest is dropped with a marker. Default 8 MiB. */
	maxOutputBytes?: number;
	/** Upper bound for a command's timeout in seconds; a command without a timeout gets this one. Default one hour. */
	maxTimeoutSeconds?: number;
	/**
	 * After a command timed out or was aborted, stop every process of this account that started during the command. Needed on Windows because
	 * background children of Git Bash lose their parent link and escape `taskkill /T`. Only safe when this account runs one job at a time.
	 */
	sweepUser?: string;
	/** Replaces the real sweep (tests). */
	sweep?: (options: SweepOptions) => Promise<number>;
}

const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;
const DEFAULT_MAX_TIMEOUT_SECONDS = 3600;

/** The real path with links, junctions and 8.3 aliases resolved (the native implementation, which sees Windows reparse points). */
const realpathNative = (path: string): Promise<string> => new Promise((resolve, reject) => realpath.native(path, (error, resolved) => (error ? reject(error) : resolve(resolved))));

/** The real path of `path`, or, while it does not exist yet, the real path of its nearest existing parent plus the missing part. */
async function realpathOfExisting(path: string, flavour: Flavour): Promise<string> {
	const impl = flavour === "win32" ? win32 : posix;
	const missing: string[] = [];
	let probe = path;
	for (;;) {
		try {
			return impl.join(await realpathNative(probe), ...missing.reverse());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = impl.dirname(probe);
			if (parent === probe) return path;
			missing.push(impl.basename(probe));
			probe = parent;
		}
	}
}

const denied = (path: string, error: unknown): Result<never, FileError> => {
	const cause = error instanceof Error ? error : new Error(String(error));
	return err(new FileError(error instanceof ConfinementError ? "permission_denied" : "unknown", cause.message, path, cause));
};

/**
 * pi-durable's `NodeExecutionEnv` on the local disk, confined to one workspace root, for a machine without a container runtime.
 *
 * What is enforced: every path the file tools (and the kit's git steps) hand to the file API must resolve inside the root, by name
 * (`resolveInside`: no `..`, UNC, drive escapes, short names, device names, streams) and by real path (junctions, symbolic links and
 * 8.3 aliases that lead outside are caught after `realpath`); commands start in a confined directory, get exactly `baseEnv` plus the
 * call's own variables, are time-limited and output-capped, and their whole process tree is killed on timeout or abort (taskkill /T /F).
 *
 * What is not: a command runs as the service account and can open any file that account can open. The account's own permissions and the
 * Windows Firewall are the boundary there, which is weaker than a container: see deploy/README.md.
 */
export class ConfinedExecutionEnv implements ExecutionEnv {
	readonly id: string;
	readonly cwd: string;
	readonly root: string;
	readonly #inner: NodeExecutionEnv;
	readonly #flavour: Flavour;
	readonly #baseEnv: Record<string, string>;
	readonly #maxOutput: number;
	readonly #maxTimeout: number;
	readonly #sweepUser: string | undefined;
	readonly #sweep: (options: SweepOptions) => Promise<number>;
	#realRoot: Promise<string> | undefined;

	constructor(options: LocalEnvOptions) {
		this.#flavour = options.flavour ?? nativeFlavour();
		this.root = (this.#flavour === "win32" ? win32 : posix).resolve(options.root);
		this.cwd = resolveInside(this.root, options.cwd ?? this.root, { flavour: this.#flavour });
		this.id = `local:${this.root}`;
		this.#baseEnv = options.baseEnv;
		this.#maxOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
		this.#maxTimeout = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
		this.#sweepUser = options.sweepUser;
		this.#sweep = options.sweep ?? sweepLeftovers;
		this.#inner = new NodeExecutionEnv({ cwd: this.cwd, shellPath: options.shellPath });
	}

	/** The confined absolute path of `path`: by name first, then by real path. */
	async confine(path: string): Promise<string> {
		const resolved = resolveInside(this.root, path, { cwd: this.cwd, flavour: this.#flavour });
		await this.#assertRealPathInside(resolved);
		return resolved;
	}

	async #assertRealPathInside(resolved: string): Promise<void> {
		this.#realRoot ??= realpathOfExisting(this.root, this.#flavour);
		let real: string;
		try {
			real = await realpathOfExisting(resolved, this.#flavour);
		} catch (error) {
			// anything but "does not exist yet" (access denied, loops, ...) refuses: fail closed
			throw new ConfinementError(`cannot verify ${resolved} (${(error as NodeJS.ErrnoException).code ?? String(error)})`);
		}
		if (!isInside(await this.#realRoot, real, this.#flavour)) throw new ConfinementError(`resolves outside the workspace root (link or junction): ${resolved}`);
	}

	async #file<T>(path: string, run: (confined: string) => Promise<Result<T, FileError>>): Promise<Result<T, FileError>> {
		let confined: string;
		try {
			confined = await this.confine(path);
		} catch (error) {
			return denied(path, error);
		}
		return run(confined);
	}

	// --- file system: every path goes through `#file` ---

	absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
		return this.#file(path, async (confined) => ok(confined));
	}
	joinPath(parts: string[], context: Context): Promise<Result<string, FileError>> {
		return this.#inner.joinPath(parts, context);
	}
	readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#file(path, (p) => this.#inner.readTextFile(p, context));
	}
	openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		return this.#file(path, (p) => this.#inner.openTextLineReader(p, context));
	}
	readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		return this.#file(path, (p) => this.#inner.readTextLines(p, options, context));
	}
	readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		return this.#file(path, (p) => this.#inner.readBinaryFile(p, context));
	}
	openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context): Promise<Result<BinaryReader, FileError>> {
		return this.#file(path, (p) => this.#inner.openBinaryReader(p, options, context));
	}
	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#file(path, (p) => this.#inner.writeFile(p, content, context));
	}
	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.#file(path, (p) => this.#inner.appendFile(p, content, context));
	}
	truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		return this.#file(path, (p) => this.#inner.truncateFile(p, size, context));
	}
	flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		return this.#file(path, (p) => this.#inner.flushFile(p, context));
	}
	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		return this.#file(sourcePath, (source) => this.#file(destinationPath, (destination) => this.#inner.renameFile(source, destination, context)));
	}
	fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		return this.#file(path, (p) => this.#inner.fileInfo(p, context));
	}
	listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		return this.#file(path, (p) => this.#inner.listDir(p, context));
	}
	openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
		return this.#file(path, (p) => this.#inner.openDirReader(p, context));
	}
	async watch(targets: readonly WatchTarget[], onChange: (change: WatchChange) => void, context: Context): Promise<Result<FileWatcher, FileError>> {
		const confined: WatchTarget[] = [];
		for (const target of targets) {
			try {
				confined.push({ ...target, path: await this.confine(target.path) });
			} catch (error) {
				return denied(target.path, error);
			}
		}
		return this.#inner.watch(confined, onChange, context);
	}
	canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		return this.#file(path, (p) => this.#inner.canonicalPath(p, context));
	}
	exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		return this.#file(path, (p) => this.#inner.exists(p, context));
	}
	createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return this.#file(path, (p) => this.#inner.createDir(p, options, context));
	}
	remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		return this.#file(path, async (p) => {
			if (p === this.root) return err(new FileError("permission_denied", "the workspace root itself cannot be removed", path));
			return this.#inner.remove(p, options, context);
		});
	}
	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.#insideRoot(await this.#inner.createTempDir(prefix, context));
	}
	async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		return this.#insideRoot(await this.#inner.createTempFile(options, context));
	}

	/** Temporary files come from the service's TEMP, which the service points inside the root; anything else is refused. */
	#insideRoot(result: Result<string, FileError>): Result<string, FileError> {
		if (!result.ok) return result;
		if (isInside(this.root, result.value, this.#flavour)) return result;
		return err(new FileError("permission_denied", `the temporary location is outside the workspace root (set TEMP inside it): ${result.value}`, result.value));
	}

	// --- commands ---

	async exec(command: string | readonly string[], options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		let cwd: string;
		try {
			cwd = options?.cwd ? await this.confine(options.cwd) : this.cwd;
		} catch (error) {
			return err(spawnError(error));
		}
		const timeout = options?.timeout === undefined ? this.#maxTimeout : Math.min(options.timeout, this.#maxTimeout);
		let delivered = 0;
		let truncated = false;
		const onOutput: ShellExecOptions["onOutput"] = options?.onOutput
			? (text, ctx, info) => {
					if (truncated) return;
					const size = Buffer.byteLength(text);
					if (delivered + size > this.#maxOutput) {
						truncated = true;
						const room = Math.max(0, this.#maxOutput - delivered);
						if (room > 0) options.onOutput!(Buffer.from(text).subarray(0, room).toString("utf8"), ctx, info);
						options.onOutput!(`\n[output truncated at ${this.#maxOutput} bytes]\n`, ctx, info);
						return;
					}
					delivered += size;
					options.onOutput!(text, ctx, info);
				}
			: undefined;
		// `inheritEnv: false`: pi-durable then passes only what is given here, so no variable of the service process reaches a command
		const startedAt = Date.now();
		const result = await this.#inner.exec(command, { ...options, cwd, env: { ...this.#baseEnv, ...(options?.env ?? {}) }, inheritEnv: false, timeout, onOutput }, context);
		if (this.#sweepUser && !result.ok && (result.error.code === "timeout" || result.error.code === "aborted")) {
			await this.#sweep({ user: this.#sweepUser, sinceMs: startedAt - 1000, protectPids: [process.pid, process.ppid] });
		}
		return result;
	}

	/**
	 * Stops every process of the sweep account that started at or after `sinceMs` (a role that started something in the background and is
	 * done with it). Returns how many were stopped; 0 when no sweep account is configured.
	 */
	async sweepSince(sinceMs: number): Promise<number> {
		if (!this.#sweepUser) return 0;
		return this.#sweep({ user: this.#sweepUser, sinceMs, protectPids: [process.pid, process.ppid] });
	}

	cleanup(context: Context): Promise<void> {
		return this.#inner.cleanup(context);
	}
}

function spawnError(error: unknown): ExecutionError {
	const cause = error instanceof Error ? error : new Error(String(error));
	return new ExecutionError("spawn_error", `Working directory is not allowed: ${cause.message}`, cause);
}

/** The environment factory the runtime and the kit's git steps use: one confined environment per working directory. */
export function localEnvFactory(options: Omit<LocalEnvOptions, "cwd">): (cwd: string | undefined) => ConfinedExecutionEnv {
	return (cwd) => new ConfinedExecutionEnv({ ...options, cwd });
}
