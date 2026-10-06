#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createHub } from "./bootstrap.ts";
import { hookToken, signingSecret } from "./derive.ts";
import { jsonLogger } from "./log.ts";
import { parseBody } from "./mapping.ts";

const USAGE = `somework-hub <command>

  dead-letters list                  pending dead letters (id, source, kind, error)
  dead-letters show <id>             one dead letter, with the start of its body
  dead-letters replay <id>|--all     run it through the mapping and publish again
  dead-letters drop <id>             delete it
  mapping test <source> <file>       run a source's mapping on a saved webhook body (headers via --header name=value)
  urls [--host <https://hooks.example>] [--receiver-config <file>]
                                     the webhook URL of every source: the secret part of each URL is printed, keep it out of logs and chat
  signing-secret <source>            the key a code host signs deliveries with for a source verified with github-hmac

Configuration is read from HUB_CONFIG and HUB_SECRET_FILE, like the service.`;

async function main(argv: string[]): Promise<number> {
	const [area, action, ...rest] = argv;
	if (!area || area === "--help" || area === "help") {
		console.log(USAGE);
		return 0;
	}
	const { hub, store, config, secret } = createHub(process.env, jsonLogger());
	try {
		if (area === "dead-letters" && action === "list") {
			for (const letter of store.deadLetters({ pending: true })) console.log([letter.id, letter.source, letter.kind, new Date(letter.createdAt).toISOString(), letter.error].join("\t"));
			return 0;
		}
		if (area === "dead-letters" && action === "show" && rest[0]) {
			const letter = store.deadLetter(rest[0]);
			if (!letter) return fail(`no dead letter ${rest[0]}`);
			const { body, query, ...meta } = letter;
			console.log(JSON.stringify({ ...meta, bytes: body.length, bodyStart: body.toString("utf8").slice(0, 2000) }, null, 2));
			return 0;
		}
		if (area === "dead-letters" && action === "replay" && rest[0]) {
			const ids = rest[0] === "--all" ? store.deadLetters({ pending: true }).map((letter) => letter.id) : [rest[0]];
			let failed = 0;
			for (const id of ids) {
				try {
					console.log(`${id}\t${JSON.stringify(await hub.replayDeadLetter(id))}`);
				} catch (error) {
					failed++;
					console.error(`${id}\tFAILED\t${(error as Error).message}`);
				}
			}
			return failed === 0 ? 0 : 1;
		}
		if (area === "dead-letters" && action === "drop" && rest[0]) return store.deleteDeadLetter(rest[0]) ? 0 : fail(`no dead letter ${rest[0]}`);
		if (area === "mapping" && action === "test" && rest[0] && rest[1]) {
			const source = config.sources.find((s) => s.name === rest[0]);
			if (!source?.mapping) return fail(`${rest[0]} has no mapping`);
			const headers: Record<string, string> = {};
			for (let i = 2; i < rest.length; i++) if (rest[i] === "--header" && rest[i + 1]) headers[rest[i + 1]!.split("=")[0]!.toLowerCase()] = rest[++i]!.split("=").slice(1).join("=");
			const body = readFileSync(rest[1]);
			const { MappingEngine } = await import("./mapping.ts");
			const result = await new MappingEngine(config.mappingsDir).run(source.mapping, source.name, { headers, body: parseBody({ headers, body }), receivedAt: new Date().toISOString(), source: source.name }, source.classification ?? config.defaultClassification);
			console.log(JSON.stringify(result, null, 2));
			return 0;
		}
		if (area === "urls") {
			const hostFlag = [action, ...rest].indexOf("--host");
			const host = hostFlag >= 0 ? [action, ...rest][hostFlag + 1] : "https://<hooks host>";
			const receiverFlag = [action, ...rest].indexOf("--receiver-config");
			const suffixes = new Map<string, string>();
			if (receiverFlag >= 0) {
				const receiverConfig = JSON.parse(readFileSync([action, ...rest][receiverFlag + 1]!, "utf8")) as { sources: { name: string; path?: string }[] };
				for (const entry of receiverConfig.sources) suffixes.set(entry.name, entry.path ?? "");
			}
			for (const source of config.sources) {
				const token = hookToken(secret, source.name, source.version);
				console.log(source.internal ? `${source.name}\tinternal\tPOST /in/${source.name}/${token}` : `${source.name}\tpublic\tPOST ${host}/hook/${source.name}/${token}${suffixes.get(source.name) ?? ""}`);
			}
			return 0;
		}
		if (area === "signing-secret" && action) {
			const source = config.sources.find((s) => s.name === action);
			if (!source) return fail(`unknown source ${action}`);
			console.log(signingSecret(secret, source.name, source.version));
			return 0;
		}
		console.error(USAGE);
		return 2;
	} finally {
		store.close();
	}
}

function fail(message: string): number {
	console.error(message);
	return 1;
}

process.exit(await main(process.argv.slice(2)));
