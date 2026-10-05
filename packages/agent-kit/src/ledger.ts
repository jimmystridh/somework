import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Daily token spend, persisted so a restart does not reset the cap. */
export class DailyLedger {
	readonly #path: string;
	readonly #limit: number;
	readonly #today: () => string;

	constructor(path: string, dailyTokenLimit: number, today: () => string = () => new Date().toISOString().slice(0, 10)) {
		this.#path = path;
		this.#limit = dailyTokenLimit;
		this.#today = today;
		mkdirSync(dirname(path), { recursive: true });
	}

	#read(): { date: string; tokens: number } {
		try {
			const state = JSON.parse(readFileSync(this.#path, "utf8")) as { date: string; tokens: number };
			if (state.date === this.#today()) return state;
		} catch {
			// no ledger yet, or a new day
		}
		return { date: this.#today(), tokens: 0 };
	}

	spent(): number {
		return this.#read().tokens;
	}

	remaining(): number {
		return Math.max(0, this.#limit - this.spent());
	}

	record(tokens: number): void {
		const state = this.#read();
		state.tokens += Math.max(0, Math.round(tokens));
		writeFileSync(`${this.#path}.tmp`, JSON.stringify(state));
		renameSync(`${this.#path}.tmp`, this.#path);
	}
}
