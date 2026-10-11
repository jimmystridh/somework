import type { SomeWorkClient } from "@somework/sdk";
import type { Log } from "./log.ts";

export const RUNTIME_HEARTBEAT_MS = 30_000;

type RuntimeClient = Pick<SomeWorkClient, "registerRuntime" | "runtimeHeartbeat" | "endRuntime">;

/**
 * The agent's runtime in the domain: registered at start, kept alive with a heartbeat (the domain calls a runtime alive for 90 seconds after
 * its last one, which is what Operations shows as health) and ended on a clean stop. A heartbeat the domain refuses (it restarted, the runtime
 * is unknown) registers the runtime again.
 */
export function keepRuntimeAlive(options: { client: RuntimeClient; meta: Record<string, string>; signal: AbortSignal; log: Log; intervalMs?: number }): { registered: Promise<void>; ended: () => Promise<void> } {
	const { client, meta, signal, log } = options;
	const register = (): Promise<void> =>
		client.registerRuntime(meta).then(
			() => undefined,
			(error: unknown) => log("warn", "runtime_register_failed", { error: String(error).slice(0, 160) }),
		);
	const registered = register();
	const beating = setInterval(() => {
		client.runtimeHeartbeat().catch(() => register());
	}, options.intervalMs ?? RUNTIME_HEARTBEAT_MS);
	beating.unref();
	signal.addEventListener("abort", () => clearInterval(beating), { once: true });
	return { registered, ended: () => client.endRuntime().then(() => undefined, () => undefined) };
}
