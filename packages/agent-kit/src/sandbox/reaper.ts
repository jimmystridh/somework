import { readdirSync, readFileSync } from "node:fs";

export interface StaleProcess {
	pid: number;
	ageSeconds: number;
	command: string;
}

export interface ReaperOptions {
	/** A process older than this is stale. Commands of a job take minutes to an hour; a day-old test run is a leftover. */
	maxAgeSeconds: number;
	/** The process that must never be touched: the sandbox itself. */
	selfPid?: number;
	/** For tests. */
	procDir?: string;
	nowSeconds?: () => number;
	ticksPerSecond?: number;
	kill?: (pid: number) => void;
	log?: (event: string, fields: Record<string, unknown>) => void;
}

/** The `starttime` of `/proc/<pid>/stat`: the field after the command name, which may hold spaces and parentheses itself. */
export function startTicksOf(stat: string): number | undefined {
	const close = stat.lastIndexOf(")");
	if (close < 0) return undefined;
	const fields = stat.slice(close + 2).split(" ");
	const ticks = Number(fields[19]);
	return Number.isFinite(ticks) ? ticks : undefined;
}

/**
 * The processes of this container that are older than `maxAgeSeconds`. In a sandbox container everything but the sandbox server is a command
 * of a job or a leftover of one (an orphan is adopted by the server, pid 1), so age alone separates a stuck test run from live work.
 */
export function staleProcesses(options: ReaperOptions): StaleProcess[] {
	const proc = options.procDir ?? "/proc";
	const ticks = options.ticksPerSecond ?? 100;
	const now = (options.nowSeconds ?? (() => Date.now() / 1000))();
	let bootSeconds: number;
	try {
		bootSeconds = Number(/^btime (\d+)$/m.exec(readFileSync(`${proc}/stat`, "utf8"))?.[1]);
	} catch {
		return [];
	}
	if (!Number.isFinite(bootSeconds)) return [];
	const stale: StaleProcess[] = [];
	for (const entry of readdirSync(proc)) {
		if (!/^[0-9]+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === (options.selfPid ?? process.pid)) continue;
		try {
			const started = startTicksOf(readFileSync(`${proc}/${entry}/stat`, "utf8"));
			if (started === undefined) continue;
			const ageSeconds = now - (bootSeconds + started / ticks);
			if (ageSeconds <= options.maxAgeSeconds) continue;
			const command = readFileSync(`${proc}/${entry}/cmdline`, "utf8").replaceAll("\u0000", " ").trim().slice(0, 200);
			stale.push({ pid, ageSeconds: Math.round(ageSeconds), command });
		} catch {
			// the process ended while it was read
		}
	}
	return stale;
}

/** Kills what `staleProcesses` finds, and says so in the log: the sandbox's own process is never among them. */
export function reapStaleProcesses(options: ReaperOptions): StaleProcess[] {
	const kill = options.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
	const stale = staleProcesses(options);
	for (const entry of stale) {
		try {
			kill(entry.pid);
			options.log?.("stale_process_killed", { pid: entry.pid, ageHours: Math.round(entry.ageSeconds / 360) / 10, command: entry.command });
		} catch (error) {
			options.log?.("stale_process_kill_failed", { pid: entry.pid, error: error instanceof Error ? error.message.slice(0, 120) : String(error) });
		}
	}
	return stale;
}
