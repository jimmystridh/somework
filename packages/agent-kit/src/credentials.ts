import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

/** A `CredentialStore` over a Pi `auth.json` (`{ "<provider>": { type, ... } }`). Writes (OAuth refresh) are serialized and atomic,
 * and go to this file only: the service never touches another Pi installation's credentials. */
export class FileCredentialStore implements CredentialStore {
	readonly #path: string;
	#chain: Promise<unknown> = Promise.resolve();

	constructor(path: string) {
		this.#path = path;
	}

	#load(): Record<string, Credential> {
		try {
			return JSON.parse(readFileSync(this.#path, "utf8")) as Record<string, Credential>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	#save(all: Record<string, Credential>): void {
		mkdirSync(dirname(this.#path), { recursive: true });
		const tmp = `${this.#path}.tmp`;
		writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.#path);
	}

	#serialized<T>(work: () => Promise<T> | T): Promise<T> {
		const next = this.#chain.then(work, work);
		this.#chain = next.catch(() => {});
		return next;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		return this.#load()[providerId];
	}

	async list(): Promise<readonly { providerId: string; type: Credential["type"] }[]> {
		return Object.entries(this.#load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
	}

	modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
		return this.#serialized(async () => {
			const all = this.#load();
			const next = await fn(all[providerId]);
			if (next === undefined) return all[providerId];
			this.#save({ ...all, [providerId]: next });
			return next;
		});
	}

	delete(providerId: string): Promise<void> {
		return this.#serialized(() => {
			const all = this.#load();
			delete all[providerId];
			this.#save(all);
		});
	}
}
