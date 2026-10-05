import { readFileSync } from "node:fs";
import type { BucketConfig } from "./limits.ts";

export interface SourceConfig {
	name: string;
	/** Bumping the version changes the source's token (and signing key): that is how a source is rotated. */
	version: number;
	/** `token`: the derived token in the URL. `github-hmac`: the token AND a valid X-Hub-Signature-256 made with the derived signing key. */
	verify?: "token" | "github-hmac";
	/** The one path suffix this source accepts after /hook/<source>/<token>, for senders that append their own route (Woodpecker adds /api/hook). Empty: none. */
	path: string;
}

export interface ReceiverConfig {
	sources: SourceConfig[];
	maxBodyBytes: number;
	perSource: BucketConfig;
	global: BucketConfig;
	authFailuresPerMinute: number;
	retentionHours: number;
}

export const SOURCE_NAME = /^[a-z][a-z0-9-]{0,30}$/;
export const SUFFIX = /^(?:\/[A-Za-z0-9._~-]{1,100}){0,8}$/;
export const hasDotSegment = (suffix: string): boolean => suffix.split("/").some((segment) => segment === "." || segment === "..");

const DEFAULTS: Omit<ReceiverConfig, "sources"> = {
	maxBodyBytes: 1024 * 1024,
	perSource: { ratePerSecond: 20, burst: 100 },
	global: { ratePerSecond: 100, burst: 400 },
	authFailuresPerMinute: 20,
	retentionHours: 24,
};

export function parseConfig(raw: unknown): ReceiverConfig {
	if (typeof raw !== "object" || raw === null) throw new Error("the receiver config must be an object");
	const input = raw as Record<string, any>;
	if (!Array.isArray(input.sources) || input.sources.length === 0) throw new Error("the receiver config needs at least one source");
	const seen = new Set<string>();
	const sources = input.sources.map((entry: Record<string, unknown>): SourceConfig => {
		const name = String(entry.name ?? "");
		if (!SOURCE_NAME.test(name)) throw new Error(`invalid source name "${name}"`);
		if (seen.has(name)) throw new Error(`duplicate source "${name}"`);
		seen.add(name);
		const version = Number(entry.version ?? 1);
		if (!Number.isInteger(version) || version < 1) throw new Error(`source ${name}: version must be a positive integer`);
		const verify = entry.verify === undefined ? "token" : String(entry.verify);
		if (verify !== "token" && verify !== "github-hmac") throw new Error(`source ${name}: unknown verify mode ${verify}`);
		const path = String(entry.path ?? "");
		if (!SUFFIX.test(path) || hasDotSegment(path)) throw new Error(`source ${name}: invalid path suffix "${path}"`);
		return { name, version, verify, path };
	});
	const limits = (key: "perSource" | "global"): BucketConfig => ({ ...DEFAULTS[key], ...(input.limits?.[key] ?? {}) });
	return {
		sources,
		maxBodyBytes: Number(input.limits?.maxBodyBytes ?? DEFAULTS.maxBodyBytes),
		perSource: limits("perSource"),
		global: limits("global"),
		authFailuresPerMinute: Number(input.limits?.authFailuresPerMinute ?? DEFAULTS.authFailuresPerMinute),
		retentionHours: Number(input.retentionHours ?? DEFAULTS.retentionHours),
	};
}

export const loadConfig = (path: string): ReceiverConfig => parseConfig(JSON.parse(readFileSync(path, "utf8")));
