import { readFileSync } from "node:fs";

export interface CliCommand {
	state: string;
	cmd: string;
	args: Record<string, unknown>;
}

const USAGE = `usage: node cli.ts --state <browser.json> <command> [arguments]
  open <url>                        open a page (only the hosts the agent allows)
  snapshot                          text outline of the page; every control has a ref like e12
  click <ref>                       click a control from the last snapshot
  click-text <text>                 click the element whose visible text is exactly this (a tree node or label that has no ref in the snapshot)
  fill <ref> <text...>              type into a field
  press <key>                       press a key, for example Enter or Control+A
  wait [--ms N] [--text T] [--selector S]
  screenshot [name]                 save a PNG
  errors                            console, page and network errors seen since the page opened
  video-start | video-stop          record the decisive pass; a video is saved only on video-stop
  status`;

export class CliUsageError extends Error {
	constructor(message: string) {
		super(`${message}\n${USAGE}`);
	}
}

/** Pure: turns the command line into the daemon's request. */
export function parseCli(argv: readonly string[]): CliCommand {
	const rest = [...argv];
	let state: string | undefined;
	if (rest[0] === "--state") {
		state = rest[1];
		rest.splice(0, 2);
	}
	if (!state) throw new CliUsageError("missing --state <browser.json>");
	const [cmd, ...params] = rest;
	if (!cmd) throw new CliUsageError("missing command");
	const args: Record<string, unknown> = {};
	switch (cmd) {
		case "open":
			if (params.length !== 1) throw new CliUsageError("open takes one URL");
			args.url = params[0];
			break;
		case "click":
			if (params.length !== 1) throw new CliUsageError("click takes one ref");
			args.ref = params[0];
			break;
		case "click-text":
			if (params.length < 1) throw new CliUsageError("click-text takes the visible text of the element");
			args.text = params.join(" ");
			break;
		case "fill":
			if (params.length < 2) throw new CliUsageError("fill takes a ref and a text");
			args.ref = params[0];
			args.text = params.slice(1).join(" ");
			break;
		case "press":
			if (params.length !== 1) throw new CliUsageError("press takes one key");
			args.key = params[0];
			break;
		case "wait":
			for (let i = 0; i < params.length; i += 2) {
				const flag = params[i];
				const value = params[i + 1];
				if (value === undefined) throw new CliUsageError(`${flag} needs a value`);
				if (flag === "--ms") args.ms = Number(value);
				else if (flag === "--text") args.text = value;
				else if (flag === "--selector") args.selector = value;
				else throw new CliUsageError(`unknown option ${flag}`);
			}
			break;
		case "screenshot":
			if (params.length > 1) throw new CliUsageError("screenshot takes at most one name");
			if (params[0]) args.name = params[0];
			break;
		case "errors":
		case "video-start":
		case "video-stop":
		case "status":
		case "snapshot":
			if (params.length > 0) throw new CliUsageError(`${cmd} takes no arguments`);
			break;
		default:
			throw new CliUsageError(`unknown command ${cmd}`);
	}
	return { state, cmd, args };
}

/** Sends one command to the daemon named by the state file. Resolves with the text to print, rejects with the message to print on stderr. */
export async function send(command: CliCommand, read: (path: string) => string = (path) => readFileSync(path, "utf8"), fetchImpl: typeof fetch = fetch): Promise<string> {
	let state: { port: number; token: string };
	try {
		state = JSON.parse(read(command.state));
	} catch {
		throw new Error(`the browser is not running (cannot read ${command.state})`);
	}
	let response: Response;
	try {
		response = await fetchImpl(`http://127.0.0.1:${state.port}/cmd`, {
			method: "POST",
			headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
			body: JSON.stringify({ cmd: command.cmd, args: command.args }),
			signal: AbortSignal.timeout(120_000),
		});
	} catch {
		throw new Error("the browser is not running (no answer from its port)");
	}
	const body = (await response.json().catch(() => undefined)) as { ok?: boolean; text?: string; error?: string } | undefined;
	if (!body) throw new Error(`unexpected answer (HTTP ${response.status})`);
	if (!body.ok) throw new Error(body.error ?? "failed");
	return body.text ?? "";
}
