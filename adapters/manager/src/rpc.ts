export class JsonLines {
	#buffer = "";
	readonly #receive: (record: any) => void;

	constructor(receive: (record: any) => void) {
		this.#receive = receive;
	}

	push(text: string): void {
		this.#buffer += text;
		let newline: number;
		while ((newline = this.#buffer.indexOf("\n")) >= 0) {
			const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.trim()) this.#receive(JSON.parse(line));
		}
		if (this.#buffer.length > 16 * 1024 * 1024) throw new Error("RPC record too large");
	}
}

export interface PiChild {
	stdin: { write(data: string, callback?: (error?: Error | null) => void): unknown; end(): unknown };
	stdout: { setEncoding(encoding: string): unknown; on(event: "data", listener: (data: string) => void): unknown };
	stderr: { on(event: "data", listener: (data: unknown) => void): unknown };
	on(event: "error" | "exit", listener: () => void): unknown;
	kill(signal?: NodeJS.Signals): unknown;
}

export interface PiRpc {
	onEvent: (event: any) => void;
	onTelemetryEvent: (event: any) => void;
	command(type: string, fields?: Record<string, unknown>, timeout?: number): Promise<any>;
}

interface Pending {
	resolve: (data: any) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/** `pi --mode rpc`: one JSON record per line in each direction; responses carry the command id, everything else is an event. */
export class ChildPiRpc implements PiRpc {
	onEvent: (event: any) => void = () => {};
	onTelemetryEvent: (event: any) => void = () => {};
	readonly #pending = new Map<string, Pending>();
	readonly #child: PiChild;
	#sequence = 0;

	constructor(child: PiChild) {
		this.#child = child;
		const lines = new JsonLines((record) => {
			const pending = record.type === "response" ? this.#pending.get(record.id) : undefined;
			if (pending) {
				this.#pending.delete(record.id);
				clearTimeout(pending.timer);
				if (record.success) pending.resolve(record.data);
				else pending.reject(new Error("Pi command failed"));
			} else {
				this.onTelemetryEvent(record);
				this.onEvent(record);
			}
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (data) => {
			try {
				lines.push(data);
			} catch {
				console.error("Invalid Pi RPC output");
				child.kill();
			}
		});
		child.stderr.on("data", () => {});
		child.on("error", () => this.#fail());
		child.on("exit", () => this.#fail());
	}

	#fail(): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Pi disconnected"));
		}
		this.#pending.clear();
	}

	command(type: string, fields: Record<string, unknown> = {}, timeout = 30_000): Promise<any> {
		const id = `telegram-${++this.#sequence}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error("Pi command timed out"));
			}, timeout);
			this.#pending.set(id, { resolve, reject, timer });
			this.#child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
				if (!error) return;
				clearTimeout(timer);
				this.#pending.delete(id);
				reject(new Error("Pi input failed"));
			});
		});
	}
}
