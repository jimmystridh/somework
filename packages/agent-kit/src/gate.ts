/**
 * How many jobs run at once, shared by the claim loop and the chat: requester tasks go first, and a chat instruction takes a slot only when
 * one is free and no task is waiting. Nothing is ever preempted: a chat instruction that has started finishes (or is stopped by its own
 * budget) before the slot is given on.
 */
export class JobGate {
	readonly #capacity: number;
	#running = 0;
	readonly #tasks: (() => void)[] = [];
	readonly #chat: (() => void)[] = [];

	constructor(capacity: number) {
		this.#capacity = Math.max(1, capacity);
	}

	get running(): number {
		return this.#running;
	}

	get waiting(): { tasks: number; chat: number } {
		return { tasks: this.#tasks.length, chat: this.#chat.length };
	}

	/** True when `acquire("chat")` would be granted at once. */
	get chatCanStart(): boolean {
		return this.#running < this.#capacity && this.#tasks.length === 0;
	}

	acquire(kind: "task" | "chat", signal?: AbortSignal): Promise<() => void> {
		return new Promise((resolve, reject) => {
			const queue = kind === "task" ? this.#tasks : this.#chat;
			const grant = (): void => {
				this.#running += 1;
				let released = false;
				resolve(() => {
					if (released) return;
					released = true;
					this.#running -= 1;
					this.#next();
				});
			};
			if (this.#running < this.#capacity && (kind === "task" || this.#tasks.length === 0)) return grant();
			const entry = grant;
			queue.push(entry);
			signal?.addEventListener(
				"abort",
				() => {
					const at = queue.indexOf(entry);
					if (at >= 0) {
						queue.splice(at, 1);
						reject(new Error("stopped while waiting for a free slot"));
					}
				},
				{ once: true },
			);
		});
	}

	#next(): void {
		while (this.#running < this.#capacity) {
			const next = this.#tasks.shift() ?? this.#chat.shift();
			if (!next) return;
			next();
		}
	}

	/** Runs `work` in a slot of the given kind. */
	async run<T>(kind: "task" | "chat", work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const release = await this.acquire(kind, signal);
		try {
			return await work();
		} finally {
			release();
		}
	}
}
