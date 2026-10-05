import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PiRpc } from "./rpc.ts";

const ACTIVITY_EVENTS = new Set(["agent_start", "agent_settled", "message_end", "tool_execution_start", "tool_execution_end"]);
const finite = (value: unknown): number | null => (Number.isFinite(value) ? (value as number) : null);

export function telemetryRecord(id: string, state: any, stats: any, lastActivityAt: string | null, now = Date.now()) {
	return {
		id,
		state: state.isStreaming ? "working" : "idle",
		observedAt: new Date(now).toISOString(),
		model: state.model?.id ?? null,
		provider: state.model?.provider ?? null,
		thinking: state.thinkingLevel ?? null,
		sessionId: state.sessionId ?? null,
		version: "0.87.1",
		lastActivityAt: lastActivityAt ?? null,
		messages: finite(stats?.totalMessages),
		tokens: finite(stats?.tokens?.total),
		cost: finite(stats?.cost),
	};
}

/** Publishes a small liveness record for the host's fleet view; the id stays `pi-demo` so the existing dashboard keeps matching it. */
export function startTelemetry(rpc: PiRpc, path: string, id = "pi-demo"): { observe(event: any): void; stop(): void } {
	let busy = false;
	let closed = false;
	let lastActivityAt: string | null = null;
	const observe = (event: any) => {
		if (ACTIVITY_EVENTS.has(event.type)) lastActivityAt = new Date().toISOString();
	};
	const publish = async () => {
		if (busy || closed) return;
		busy = true;
		try {
			const state = await rpc.command("get_state", {}, 8000);
			const stats = await rpc.command("get_session_stats", {}, 8000).catch(() => null);
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(`${path}.tmp`, JSON.stringify(telemetryRecord(id, state, stats, lastActivityAt)), { mode: 0o600 });
			if (!closed) await rename(`${path}.tmp`, path);
		} catch {
			console.error("Pi telemetry sample unavailable");
		} finally {
			busy = false;
		}
	};
	const timer = setInterval(publish, 10_000);
	timer.unref();
	void publish();
	return {
		observe,
		stop: () => {
			closed = true;
			clearInterval(timer);
		},
	};
}
