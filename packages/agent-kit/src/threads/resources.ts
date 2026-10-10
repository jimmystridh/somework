/**
 * Singleton resources: things only one job at a time can use (the QA machine's application stack and browser, a build workspace). A job names
 * what it needs when it starts; it waits, first come first served per resource (a request from a person goes ahead of automated ones), until
 * all of it is free, and everything is taken or nothing. The registry is in memory: it protects the jobs of one process, and the physical
 * access points (a start script, a browser daemon) are where a lock must also be taken for shell commands that bypass the kit.
 */
export interface Holder {
	/** Who holds it: a job id. */
	holder: string;
	/** What the holder is doing, for people and for the model ("verification of SAD-2133"). */
	label: string;
}

export interface Hold extends Holder {
	resource: string;
	since: number;
}

export interface Waiting extends Holder {
	resources: string[];
	since: number;
}

interface Pending extends Waiting {
	seq: number;
	priority: number;
	grant: (release: () => void) => void;
	reject: (error: Error) => void;
	onWait?: (blocking: Hold[]) => void;
}

export class ResourceRegistry {
	readonly #held = new Map<string, Hold>();
	readonly #pending: Pending[] = [];
	readonly #now: () => number;
	#seq = 0;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	holders(): Hold[] {
		return [...this.#held.values()].sort((a, b) => a.since - b.since);
	}

	holderOf(resource: string): Hold | undefined {
		return this.#held.get(resource);
	}

	waiting(): Waiting[] {
		return this.#pending.map(({ holder, label, resources, since }) => ({ holder, label, resources, since }));
	}

	/**
	 * Takes all of `resources` for `who`, waiting while any is held. `onWait` is told once, when the wait begins, what is in the way. The
	 * returned function releases; releasing twice is harmless. Rejects when `signal` aborts while waiting.
	 */
	acquire(resources: readonly string[], who: Holder, options: { signal?: AbortSignal; priority?: number; onWait?: (blocking: Hold[]) => void } = {}): Promise<() => void> {
		const names = [...new Set(resources)].sort();
		if (names.length === 0) return Promise.resolve(() => undefined);
		return new Promise((resolve, reject) => {
			const entry: Pending = {
				...who,
				resources: names,
				since: this.#now(),
				seq: this.#seq++,
				priority: options.priority ?? 0,
				grant: resolve,
				reject,
				...(options.onWait ? { onWait: options.onWait } : {}),
			};
			const blocking = this.#blockedBy(entry);
			if (blocking.length === 0 && this.#pending.length === 0) return resolve(this.#take(entry));
			this.#pending.push(entry);
			this.#pending.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
			const abort = () => {
				const at = this.#pending.indexOf(entry);
				if (at < 0) return;
				this.#pending.splice(at, 1);
				reject(new Error(`stopped while waiting for ${names.join(", ")}`));
				this.#drain();
			};
			if (options.signal?.aborted) return abort();
			options.signal?.addEventListener("abort", abort, { once: true });
			entry.grant = (release) => {
				options.signal?.removeEventListener("abort", abort);
				resolve(release);
			};
			entry.onWait?.(blocking.length > 0 ? blocking : this.#blockedByQueue(entry));
		});
	}

	#blockedBy(entry: Pending): Hold[] {
		return entry.resources.flatMap((name) => {
			const hold = this.#held.get(name);
			return hold ? [hold] : [];
		});
	}

	/** Held resources and the resources an earlier waiter wants: what a request has to wait for. */
	#blockedByQueue(entry: Pending): Hold[] {
		const held = this.#blockedBy(entry);
		if (held.length > 0) return held;
		const earlier = this.#pending.filter((other) => other !== entry && other.resources.some((name) => entry.resources.includes(name)) && (other.priority > entry.priority || (other.priority === entry.priority && other.seq < entry.seq)));
		return earlier.map((other) => ({ resource: other.resources.find((name) => entry.resources.includes(name))!, holder: other.holder, label: `waiting: ${other.label}`, since: other.since }));
	}

	#take(entry: Pending): () => void {
		const since = this.#now();
		for (const resource of entry.resources) this.#held.set(resource, { resource, holder: entry.holder, label: entry.label, since });
		let released = false;
		return () => {
			if (released) return;
			released = true;
			for (const resource of entry.resources) if (this.#held.get(resource)?.holder === entry.holder) this.#held.delete(resource);
			this.#drain();
		};
	}

	#drain(): void {
		const blocked = new Set<string>();
		for (const entry of [...this.#pending]) {
			const free = entry.resources.every((name) => !this.#held.has(name) && !blocked.has(name));
			if (free) {
				this.#pending.splice(this.#pending.indexOf(entry), 1);
				entry.grant(this.#take(entry));
			} else {
				for (const name of entry.resources) blocked.add(name);
			}
		}
	}
}
