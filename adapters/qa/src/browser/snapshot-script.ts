/**
 * Runs INSIDE the page (Playwright serialises the function, so it must use nothing from this module): a text outline of what a person
 * sees, in which every control carries a ref (`e12`) that is also written onto the element as `data-qa-ref` so a later click can find it.
 * Hidden elements are left out; passwords are never shown; iframes and shadow roots are not entered.
 */
export function buildSnapshot(limits: { maxLines: number; maxChars: number }): { lines: string[]; truncated: boolean } {
	const lines: string[] = [];
	let chars = 0;
	let truncated = false;
	let refs = 0;
	document.querySelectorAll("[data-qa-ref]").forEach((element) => element.removeAttribute("data-qa-ref"));
	const skip = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "PATH", "HEAD", "META", "LINK"]);
	const controls =
		'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=radio],[role=switch],[role=option],[role=combobox],[role=textbox],[contenteditable=true]';
	const clean = (text: string | null | undefined, max: number): string => (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
	const visible = (element: Element): boolean => {
		const box = element.getBoundingClientRect();
		if (box.width === 0 && box.height === 0) return false;
		const style = getComputedStyle(element);
		return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
	};
	const roleOf = (element: any): string => {
		const explicit = element.getAttribute("role");
		if (explicit) return explicit;
		switch (element.tagName) {
			case "A": return "link";
			case "BUTTON":
			case "SUMMARY": return "button";
			case "SELECT": return "combobox";
			case "TEXTAREA": return "textbox";
			case "INPUT": {
				const type = (element.type || "text").toLowerCase();
				if (type === "checkbox" || type === "radio") return type;
				if (type === "submit" || type === "button" || type === "reset") return "button";
				return "textbox";
			}
			default: return element.tagName.toLowerCase();
		}
	};
	const labelOf = (element: any): string => {
		const isField = element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT";
		const labelled = element.labels && element.labels[0] ? element.labels[0].textContent : "";
		const own = isField ? "" : element.innerText;
		const submitText = isField && ["submit", "button", "reset"].includes((element.type || "").toLowerCase()) ? element.value : "";
		return clean(element.getAttribute("aria-label") || labelled || element.getAttribute("title") || own || submitText || element.getAttribute("placeholder") || element.getAttribute("alt"), 100);
	};
	const push = (line: string, depth: number): void => {
		if (lines.length >= limits.maxLines || chars + line.length > limits.maxChars) {
			truncated = true;
			return;
		}
		const text = `${"  ".repeat(Math.min(depth, 8))}${line}`;
		chars += text.length + 1;
		lines.push(text);
	};
	const walk = (node: Node, depth: number): void => {
		if (truncated) return;
		if (node.nodeType === 3) {
			const text = clean(node.textContent, 200);
			if (text) push(text, depth);
			return;
		}
		if (node.nodeType !== 1) return;
		const element = node as any;
		if (skip.has(element.tagName.toUpperCase()) || !visible(element)) return;
		if (element.matches(controls)) {
			const ref = `e${++refs}`;
			element.setAttribute("data-qa-ref", ref);
			const state: string[] = [];
			if (element.disabled || element.getAttribute("aria-disabled") === "true") state.push("disabled");
			if (element.checked || element.getAttribute("aria-checked") === "true") state.push("checked");
			if (element.getAttribute("aria-expanded")) state.push(`expanded=${element.getAttribute("aria-expanded")}`);
			if (element.getAttribute("aria-selected") === "true") state.push("selected");
			const type = (element.type || "").toLowerCase();
			if ((element.tagName === "INPUT" || element.tagName === "TEXTAREA") && type !== "password" && type !== "checkbox" && type !== "radio" && element.value) state.push(`value="${clean(element.value, 80)}"`);
			if (element.tagName === "SELECT" && element.selectedOptions && element.selectedOptions[0]) state.push(`value="${clean(element.selectedOptions[0].text, 80)}"`);
			push(`[${ref}] ${roleOf(element)} "${labelOf(element)}"${state.length ? ` (${state.join(", ")})` : ""}`, depth);
			return;
		}
		if (/^H[1-6]$/.test(element.tagName)) {
			push(`${"#".repeat(Number(element.tagName[1]))} ${clean(element.innerText, 200)}`, depth);
			return;
		}
		const deeper = /^(DIV|SECTION|MAIN|NAV|ASIDE|HEADER|FOOTER|UL|OL|TABLE|TBODY|TR|FORM|FIELDSET|DIALOG)$/.test(element.tagName) ? depth + 1 : depth;
		for (const child of element.childNodes) walk(child, deeper);
	};
	if (document.body) walk(document.body, 0);
	return { lines, truncated };
}
