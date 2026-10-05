import { spawn } from "node:child_process";

export interface SweepOptions {
	/** The account whose leftovers are removed (the service account: nothing else of value runs under it while a job is running). */
	user: string;
	/** Only processes created at or after this instant (epoch milliseconds) are candidates. */
	sinceMs: number;
	/** Process ids that must survive (the service itself and its parent). */
	protectPids: readonly number[];
}

const SAFE_USER = /^[A-Za-z0-9._$-]{1,64}$/;

/**
 * PowerShell 5.1 that stops every process of `user` created since `sinceMs`, and prints how many it stopped.
 *
 * Why this exists: under Git for Windows the children of a backgrounded command report a dead intermediate process as their parent, so
 * `taskkill /T` (which walks parent links) cannot reach them and they outlive a command that timed out. The service account runs one job
 * at a time, so "this account's processes that started during the command" is exactly the command's descendants.
 */
export function buildSweepScript(options: SweepOptions): string {
	if (!SAFE_USER.test(options.user)) throw new Error(`not a usable account name: ${options.user}`);
	if (!Number.isSafeInteger(options.sinceMs) || options.sinceMs <= 0) throw new Error("sinceMs must be an epoch time in milliseconds");
	const protect = options.protectPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
	return [
		"$ErrorActionPreference = 'SilentlyContinue'",
		`$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${options.sinceMs}).LocalDateTime`,
		`$protect = @(${protect.join(",")})`,
		"$stopped = 0",
		"foreach ($p in Get-CimInstance Win32_Process) {",
		"  if ($p.ProcessId -eq $PID -or $protect -contains $p.ProcessId -or $p.Name -eq 'conhost.exe') { continue }",
		"  if (-not $p.CreationDate -or $p.CreationDate -lt $since) { continue }",
		"  $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwner",
		`  if ($owner.User -eq '${options.user}') { Stop-Process -Id $p.ProcessId -Force; $stopped++ }`,
		"}",
		"Write-Output $stopped",
	].join("\n");
}

export type RunPowerShell = (script: string) => Promise<string>;

const runPowerShell: RunPowerShell = (script) =>
	new Promise((resolve, reject) => {
		const encoded = Buffer.from(script, "utf16le").toString("base64");
		const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
		child.once("error", reject);
		child.once("close", () => resolve(out));
	});

/** Stops the leftovers of a command; returns how many processes it stopped. Never throws: a failed sweep must not turn into a failed job. */
export async function sweepLeftovers(options: SweepOptions, run: RunPowerShell = runPowerShell): Promise<number> {
	try {
		const out = await run(buildSweepScript(options));
		const count = Number.parseInt(out.trim().split(/\s+/).pop() ?? "0", 10);
		return Number.isFinite(count) ? count : 0;
	} catch {
		return 0;
	}
}
