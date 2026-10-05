/** A tiny Prometheus text-format registry: counters, gauges and histograms with labels. No dependency. */
type Labels = Record<string, string>;
const key = (labels: Labels): string => Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v.replace(/[\\"\n]/g, "_")}"`).join(",");

export class Metrics {
	readonly #help = new Map<string, { type: string; help: string }>();
	readonly #values = new Map<string, Map<string, number>>();
	readonly #histograms = new Map<string, { buckets: number[]; series: Map<string, { counts: number[]; sum: number; count: number }> }>();

	counter(name: string, help: string): (labels?: Labels, by?: number) => void {
		this.#help.set(name, { type: "counter", help });
		return (labels = {}, by = 1) => this.#add(name, labels, by);
	}

	gauge(name: string, help: string): { set(value: number, labels?: Labels): void; add(by: number, labels?: Labels): void } {
		this.#help.set(name, { type: "gauge", help });
		return { set: (value, labels = {}) => this.#set(name, labels, value), add: (by, labels = {}) => this.#add(name, labels, by) };
	}

	histogram(name: string, help: string, buckets: number[]): (value: number, labels?: Labels) => void {
		this.#help.set(name, { type: "histogram", help });
		const store = { buckets: [...buckets].sort((a, b) => a - b), series: new Map<string, { counts: number[]; sum: number; count: number }>() };
		this.#histograms.set(name, store);
		return (value, labels = {}) => {
			const k = key(labels);
			const series = store.series.get(k) ?? { counts: store.buckets.map(() => 0), sum: 0, count: 0 };
			store.buckets.forEach((bound, i) => {
				if (value <= bound) series.counts[i]! += 1;
			});
			series.sum += value;
			series.count += 1;
			store.series.set(k, series);
		};
	}

	#add(name: string, labels: Labels, by: number): void {
		const series = this.#values.get(name) ?? new Map<string, number>();
		series.set(key(labels), (series.get(key(labels)) ?? 0) + by);
		this.#values.set(name, series);
	}

	#set(name: string, labels: Labels, value: number): void {
		const series = this.#values.get(name) ?? new Map<string, number>();
		series.set(key(labels), value);
		this.#values.set(name, series);
	}

	render(): string {
		const lines: string[] = [];
		const wrap = (k: string, extra = "") => (k || extra ? `{${[k, extra].filter(Boolean).join(",")}}` : "");
		for (const [name, { type, help }] of this.#help) {
			lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
			if (type === "histogram") {
				const store = this.#histograms.get(name)!;
				for (const [k, series] of store.series) {
					store.buckets.forEach((bound, i) => lines.push(`${name}_bucket${wrap(k, `le="${bound}"`)} ${series.counts[i]}`));
					lines.push(`${name}_bucket${wrap(k, 'le="+Inf"')} ${series.count}`, `${name}_sum${wrap(k)} ${series.sum}`, `${name}_count${wrap(k)} ${series.count}`);
				}
			} else {
				for (const [k, value] of this.#values.get(name) ?? []) lines.push(`${name}${wrap(k)} ${value}`);
			}
		}
		return `${lines.join("\n")}\n`;
	}
}
