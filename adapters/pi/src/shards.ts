import { createHash } from "node:crypto";

/** A fixed number of logical shards: adding workers moves whole shards deliberately, never remaps every key. */
export const DEFAULT_SHARD_COUNT = 64;

export function shardOf(agentKey: string, shardCount = DEFAULT_SHARD_COUNT): number {
	return createHash("sha256").update(agentKey).digest().readUInt32BE(0) % shardCount;
}

/** Explicit ownership: agent id -> shard ranges `[from, to]` (inclusive). Every shard must have exactly one owner. */
export interface ShardTable {
	shardCount: number;
	owners: Record<string, [number, number][]>;
}

export function validateTable(table: ShardTable): void {
	const owner = new Map<number, string>();
	for (const [agent, ranges] of Object.entries(table.owners)) {
		for (const [from, to] of ranges) {
			if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= from && to < table.shardCount)) throw new Error(`invalid shard range [${from}, ${to}] for ${agent}`);
			for (let shard = from; shard <= to; shard++) {
				const previous = owner.get(shard);
				if (previous && previous !== agent) throw new Error(`shard ${shard} is owned by both ${previous} and ${agent}`);
				owner.set(shard, agent);
			}
		}
	}
	const missing = Array.from({ length: table.shardCount }, (_, shard) => shard).filter((shard) => !owner.has(shard));
	if (missing.length > 0) throw new Error(`shards without an owner: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", ..." : ""}`);
}

export function ownerOf(table: ShardTable, agentKey: string): string {
	const shard = shardOf(agentKey, table.shardCount);
	for (const [agent, ranges] of Object.entries(table.owners)) if (ranges.some(([from, to]) => shard >= from && shard <= to)) return agent;
	throw new Error(`no owner for shard ${shard}`);
}

/** What a requester sets as `targetAgentId`. */
export const routeTask = ownerOf;

export const ownsKey = (table: ShardTable, agentId: string, agentKey: string): boolean => ownerOf(table, agentKey) === agentId;
