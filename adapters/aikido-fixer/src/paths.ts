// Glob rules: a double star crosses directories, a single star does not, and a leading double star plus slash also matches nothing, so the pattern for CODEOWNERS covers the root file. Case-sensitive, relative paths with forward slashes.
export function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i]!;
		if (char === "*" && pattern[i + 1] === "*") {
			if (pattern[i + 2] === "/") {
				out += "(?:.*/)?";
				i += 2;
			} else {
				out += ".*";
				i += 1;
			}
		} else if (char === "*") out += "[^/]*";
		else if (char === "?") out += "[^/]";
		else out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

export function matchesAny(path: string, patterns: readonly string[]): string | undefined {
	const normal = path.replaceAll("\\", "/").replace(/^\.\//, "");
	return patterns.find((pattern) => globToRegExp(pattern).test(normal));
}
