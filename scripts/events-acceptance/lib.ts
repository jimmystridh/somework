import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Identity, SomeWorkClient } from "@somework/sdk";

export const pilotFile = (name: string): string => join(homedir(), ".somework-pilot", name);
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function client(keyFile: string): SomeWorkClient {
	return new SomeWorkClient({
		baseUrl: process.env.SOMEWORK_URL ?? "https://127.0.0.1:18443",
		identity: Identity.fromFile(keyFile),
		caFile: pilotFile("pki/ca.pem"),
		requireTls: true,
	});
}

export const deployer = (): SomeWorkClient => client(pilotFile("rules-deployer.key.json"));
export const producer = (): SomeWorkClient => client(pilotFile("acceptance.key.json"));
export const requester = (): SomeWorkClient => client(pilotFile("pi-requester.key.json"));

export function ssh(host: string, command: string, input?: string): string {
	return execFileSync("ssh", [host, command], { encoding: "utf8", input, maxBuffer: 32 * 1024 * 1024 });
}

const AGENT_HOST = "admin-cloud-agents";
export const developerStatus = (): any => JSON.parse(ssh(AGENT_HOST, "curl -s -m5 http://10.10.10.11:8081/status"));

/** The structured log lines of the developer agent since `since` (docker duration like 2m), optionally only the named events. */
export function developerLogs(since: string, events?: string[]): any[] {
	const raw = ssh(AGENT_HOST, `cd ~/somework-pilot/pi-agent && docker compose logs --no-log-prefix --since ${since} agent 2>&1`);
	const lines: any[] = [];
	for (const line of raw.split("\n")) {
		try {
			const parsed = JSON.parse(line);
			if (!events || events.includes(parsed.event)) lines.push(parsed);
		} catch {
			// not a structured line
		}
	}
	return lines;
}

/** Installs a handler through the kit's own store (the code path of the handler_save tool) inside the developer container. */
export function saveHandler(name: string, source: string): any {
	const script = `
import { HandlerStore } from "/app/packages/agent-kit/src/events/store.ts";
const chunks = []; for await (const c of process.stdin) chunks.push(c);
const { name, source } = JSON.parse(Buffer.concat(chunks).toString());
const store = new HandlerStore("/state/handlers");
console.log(JSON.stringify(store.save(name, source)));`;
	return JSON.parse(ssh(AGENT_HOST, `sudo docker exec -i somework-pi-agent-1 node --input-type=module -e '${script.replace(/'/g, "'\\''")}'`, JSON.stringify({ name, source })));
}

export function removeHandler(name: string): void {
	ssh(AGENT_HOST, `sudo docker exec somework-pi-agent-1 sh -c 'rm -f /state/handlers/${name}.mjs'`);
}

const ADMIN_HOST = "admin-cloud-services";
const OPS = "cd ~/somework-pilot/vm105 && docker compose --profile tools run --rm -T ops admin --config /etc/somework/somework.toml";
export const ops = (args: string): string => ssh(ADMIN_HOST, `${OPS} ${args} 2>&1`);

/** Calls the admin API as the domain's root principal (assertion minted on the services VM, used over the SSH tunnel). */
export function adminApi(method: string, path: string, body?: unknown): any {
	const token = ssh(ADMIN_HOST, `${OPS} token --key /data/root.key.json 2>/dev/null | tail -1`).trim();
	const args = ["-s", "-m", "30", "--cacert", pilotFile("pki/ca.pem"), "-X", method, "-H", `Authorization: Bearer ${token}`, "-H", "Content-Type: application/json"];
	if (body !== undefined) args.push("--data", JSON.stringify(body));
	const out = execFileSync("curl", [...args, `${process.env.SOMEWORK_URL ?? "https://127.0.0.1:18443"}${path}`], { encoding: "utf8" });
	return out ? JSON.parse(out) : undefined;
}

export const principals = (): any[] => adminApi("GET", "/v1/admin/principals").principals;
export const principal = (id: string): any => principals().find((p) => p.id === id);
