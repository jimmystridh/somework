import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { checkSecret } from "./derive.ts";
import { HttpForwarder } from "./forwarder.ts";
import { Hub } from "./hub.ts";
import type { Log } from "./log.ts";
import { MappingEngine } from "./mapping.ts";
import { DomainPublisher } from "./publisher.ts";
import { ReceiverClient } from "./receiver-client.ts";
import { Store } from "./store.ts";

export function createHub(env: NodeJS.ProcessEnv, log: Log) {
	const configPath = env.HUB_CONFIG ?? "/etc/hub/hub.config.json";
	const config = loadConfig(configPath);
	if (!env.HUB_SECRET_FILE) throw new Error("HUB_SECRET_FILE is required");
	const secret = checkSecret(readFileSync(env.HUB_SECRET_FILE, "utf8"));
	const store = new Store(config.storePath);
	const keyFiles: Record<string, string> = Object.fromEntries(config.sources.filter((s) => s.producer).map((s) => [s.name, s.producer!.keyFile]));
	if (config.clock.producer) keyFiles.clock = config.clock.producer.keyFile;
	const hub = new Hub({
		config,
		secret,
		store,
		log,
		receiver: new ReceiverClient({ url: config.receiver.url, ...(config.receiver.caFile ? { caFile: config.receiver.caFile } : {}) }, secret),
		publisher: new DomainPublisher({ domainUrl: config.domain.url, ...(config.domain.caFile ? { caFile: config.domain.caFile } : {}), requireTls: config.domain.requireTls, keyFiles }),
		forwarder: new HttpForwarder(),
		mappings: new MappingEngine(config.mappingsDir),
	});
	return { hub, store, config, secret };
}
