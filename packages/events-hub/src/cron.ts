/** Five-field cron (minute hour day-of-month month day-of-week) evaluated in an IANA time zone. Days follow the usual rule: when both the
 * day-of-month and the day-of-week field are restricted, either may match. A local time that does not exist (the spring-forward gap) is
 * skipped; a local time that happens twice (the autumn repeat) fires once. */
export interface CronSpec {
	minutes: Set<number>;
	hours: Set<number>;
	days: Set<number>;
	months: Set<number>;
	weekdays: Set<number>;
	anyDay: boolean;
	anyWeekday: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(text: string, min: number, max: number, names?: string[]): { values: Set<number>; star: boolean } {
	const values = new Set<number>();
	const number = (token: string): number => {
		const named = names?.indexOf(token.toLowerCase());
		const value = named !== undefined && named >= 0 ? named + (min === 1 ? 1 : 0) : Number(token);
		if (!Number.isInteger(value) || value < min || value > max) throw new Error(`cron value "${token}" is outside ${min}-${max}`);
		return value;
	};
	for (const part of text.split(",")) {
		const [range, stepText] = part.split("/") as [string, string | undefined];
		const step = stepText === undefined ? 1 : Number(stepText);
		if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step in "${part}"`);
		let from: number;
		let to: number;
		if (range === "*") [from, to] = [min, max];
		else if (range.includes("-")) {
			const [a, b] = range.split("-") as [string, string];
			[from, to] = [number(a), number(b)];
		} else {
			from = number(range);
			to = stepText === undefined ? from : max;
		}
		if (from > to) throw new Error(`invalid cron range "${part}"`);
		for (let value = from; value <= to; value += step) values.add(value);
	}
	return { values, star: text === "*" || text.startsWith("*/") };
}

export function parseCron(expression: string): CronSpec {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) throw new Error(`cron expression "${expression}" must have five fields`);
	const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
	const weekdays = parseField(weekday, 0, 7, WEEKDAYS);
	if (weekdays.values.has(7)) {
		weekdays.values.delete(7);
		weekdays.values.add(0);
	}
	const days = parseField(day, 1, 31);
	return {
		minutes: parseField(minute, 0, 59).values,
		hours: parseField(hour, 0, 23).values,
		days: days.values,
		months: parseField(month, 1, 12, MONTHS).values,
		weekdays: weekdays.values,
		anyDay: days.star,
		anyWeekday: weekdays.star,
	};
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
	let f = formatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
		formatters.set(timeZone, f);
	}
	return f;
}

export function assertTimeZone(timeZone: string): void {
	formatter(timeZone);
}

/** Offset of the zone from UTC at an instant, in milliseconds. */
export function offsetAt(ms: number, timeZone: string): number {
	const parts: Record<string, number> = {};
	for (const part of formatter(timeZone).formatToParts(new Date(Math.floor(ms / 1000) * 1000))) if (part.type !== "literal") parts[part.type] = Number(part.value);
	return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which the wall clock of the zone shows the given local time (two passes settle the offset across a transition). */
export function zonedToUtc(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): number {
	const naive = Date.UTC(year, month - 1, day, hour, minute);
	const first = naive - offsetAt(naive, timeZone);
	return naive - offsetAt(first, timeZone);
}

const BUCKET_MS = 15 * 60_000;

export function nextAfter(spec: CronSpec, timeZone: string, afterMs: number): number | null {
	const offsets = new Map<number, number>();
	const offset = (t: number): number => {
		const bucket = Math.floor(t / BUCKET_MS);
		let value = offsets.get(bucket);
		if (value === undefined) {
			value = offsetAt(bucket * BUCKET_MS, timeZone);
			offsets.set(bucket, value);
		}
		return value;
	};
	const localKey = (t: number): number => Math.floor((t + offset(t)) / 60_000);
	const dayMatches = (d: Date): boolean => {
		const inDays = spec.days.has(d.getUTCDate());
		const inWeekdays = spec.weekdays.has(d.getUTCDay());
		if (spec.anyDay && spec.anyWeekday) return true;
		if (spec.anyDay) return inWeekdays;
		if (spec.anyWeekday) return inDays;
		return inDays || inWeekdays;
	};

	let t = Math.floor(afterMs / 60_000) * 60_000 + 60_000;
	const limit = t + 5 * 366 * 86_400_000;
	while (t <= limit) {
		const local = new Date(t + offset(t));
		if (!spec.months.has(local.getUTCMonth() + 1) || !dayMatches(local)) {
			const next = zonedToUtc(timeZone, local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate() + 1, 0, 0);
			t = next > t ? next : t + 3_600_000;
			continue;
		}
		if (!spec.hours.has(local.getUTCHours())) {
			t += (60 - local.getUTCMinutes()) * 60_000;
			continue;
		}
		if (!spec.minutes.has(local.getUTCMinutes())) {
			t += 60_000;
			continue;
		}
		if (localKey(t - 3_600_000) === localKey(t)) {
			t += 60_000;
			continue;
		}
		return t;
	}
	return null;
}

/** The gap between the next two occurrences after `from`, used to pick the default missed-run policy of a schedule. */
export function typicalIntervalMs(spec: CronSpec, timeZone: string, from: number): number {
	const first = nextAfter(spec, timeZone, from);
	const second = first === null ? null : nextAfter(spec, timeZone, first);
	return first === null || second === null ? Infinity : second - first;
}

/** The wall-clock minute of an instant in the zone, `2026-10-05T23:00`: the part of a clock event's key that names the scheduled minute. */
export const localMinute = (ms: number, timeZone: string): string => new Date(ms + offsetAt(ms, timeZone)).toISOString().slice(0, 16);

/** `2026-10-05T23:00:00+02:00` */
export function isoWithOffset(ms: number, timeZone: string): string {
	const offset = offsetAt(ms, timeZone);
	const sign = offset < 0 ? "-" : "+";
	const minutes = Math.abs(offset) / 60_000;
	return `${new Date(ms + offset).toISOString().slice(0, 19)}${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
