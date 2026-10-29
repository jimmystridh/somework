import type { PrintRecord } from "./backend.ts";

/**
 * Runs INSIDE every frame of the page before its own scripts (Playwright serialises the function, so it must use nothing from this
 * module). The headless browser has no print dialog: `print()` returns at once and nothing says what was printed. This notes each call
 * (the frame, its title and the start of its text; for a blob document also its size and whether it is a PDF) on the top window, and
 * fires `beforeprint` and `afterprint` when the browser did not, so the page behaves as after a printer finished.
 */
export function recordPrints(): void {
	const log = (): PrintRecord[] => {
		try {
			const top: any = window.top;
			return (top.__qaPrints ??= []);
		} catch {
			return ((window as any).__qaPrints ??= []);
		}
	};
	const original = window.print.bind(window);
	window.print = () => {
		const seen = { before: false, after: false };
		const before = () => void (seen.before = true);
		const after = () => void (seen.after = true);
		window.addEventListener("beforeprint", before);
		window.addEventListener("afterprint", after);
		const record: PrintRecord = {
			frame: location.href.slice(0, 200),
			title: document.title,
			text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
		};
		log().push(record);
		if (location.protocol === "blob:") {
			fetch(location.href)
				.then(async (response) => {
					const body = new Uint8Array(await response.arrayBuffer());
					record.bytes = body.length;
					record.pdf = String.fromCharCode(...body.slice(0, 5)) === "%PDF-";
				})
				.catch(() => {});
		}
		try {
			original();
		} finally {
			window.removeEventListener("beforeprint", before);
			window.removeEventListener("afterprint", after);
			if (!seen.before) window.dispatchEvent(new Event("beforeprint"));
			if (!seen.after) window.dispatchEvent(new Event("afterprint"));
		}
	};
}
