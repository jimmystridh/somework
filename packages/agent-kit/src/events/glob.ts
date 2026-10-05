/** Topic globs: `*` matches any run of characters (including dots), everything else is literal. */
export function globMatch(pattern: string, value: string): boolean {
	if (pattern === "*") return true;
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`).test(value);
}
