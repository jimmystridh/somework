import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A document as it is kept on disk: what arrived (already checked), the hash of the bytes it arrived as, and when it took effect. */
export interface StoredDocument {
	sha256: string;
	appliedAt: string;
	document: unknown;
}

export type StoredName = "override" | "limits";

/** `<state>/setup/override.json` and `limits.json`, each written whole through a temporary file so a crash never leaves half of one. */
export class SetupFiles {
	readonly #dir: string;

	constructor(dir: string) {
		this.#dir = dir;
	}

	read(name: StoredName): StoredDocument | undefined {
		try {
			const stored = JSON.parse(readFileSync(join(this.#dir, `${name}.json`), "utf8"));
			if (typeof stored?.sha256 === "string" && typeof stored?.appliedAt === "string" && stored.document !== undefined) return stored as StoredDocument;
		} catch {
			// nothing applied yet, or a file that cannot be read: the agent starts without it
		}
		return undefined;
	}

	write(name: StoredName, stored: StoredDocument): void {
		mkdirSync(this.#dir, { recursive: true });
		const file = join(this.#dir, `${name}.json`);
		writeFileSync(`${file}.tmp`, JSON.stringify(stored), { mode: 0o600 });
		renameSync(`${file}.tmp`, file);
	}
}
