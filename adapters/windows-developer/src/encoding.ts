/** What a file's bytes are, as far as this check cares. */
export type ByteEncoding = "ascii" | "utf8" | "legacy";
export type LineEndings = "none" | "lf" | "crlf" | "mixed";

export interface ByteProfile {
	encoding: ByteEncoding;
	/** "utf8" | "utf16le" | "utf16be" when the file starts with a byte order mark. */
	bom?: "utf8" | "utf16le" | "utf16be";
	lineEndings: LineEndings;
	nul: boolean;
	/** U+FFFD sequences in a valid UTF-8 file: the trace of text that was decoded with the wrong encoding and written back. */
	replacementCharacters: number;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });

function bomOf(bytes: Uint8Array): ByteProfile["bom"] {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf8";
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf16be";
	return undefined;
}

/** Windows-1252 (and every other 8-bit legacy encoding) shows up as bytes >= 0x80 that are not valid UTF-8. */
export function profileBytes(bytes: Uint8Array): ByteProfile {
	let high = false;
	let nul = false;
	let crlf = 0;
	let lf = 0;
	let cr = 0;
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]!;
		if (byte >= 0x80) high = true;
		else if (byte === 0) nul = true;
		else if (byte === 0x0d) {
			if (bytes[i + 1] === 0x0a) {
				crlf++;
				i++;
			} else cr++;
		} else if (byte === 0x0a) lf++;
	}
	let encoding: ByteEncoding = "ascii";
	let replacementCharacters = 0;
	if (high) {
		try {
			const text = utf8Strict.decode(bytes);
			encoding = "utf8";
			for (const _ of text.matchAll(/�/g)) replacementCharacters++;
		} catch {
			encoding = "legacy";
		}
	}
	const lineEndings: LineEndings = crlf + lf + cr === 0 ? "none" : crlf > 0 && lf === 0 && cr === 0 ? "crlf" : lf > 0 && crlf === 0 && cr === 0 ? "lf" : "mixed";
	return { encoding, bom: bomOf(bytes), lineEndings, nul, replacementCharacters };
}

/** What the repository expects of a file whose "before" is plain ASCII: any non-ASCII byte could be Windows-1252 or UTF-8. */
export type ExpectedEncoding = "preserve" | "legacy" | "utf8";

export type EncodingVerdict = { ok: true } | { ok: false; reasons: string[] };

/**
 * Did the change keep the file's encoding, byte order mark and line-ending style? `before` is the file as it is in the base revision,
 * `after` the working copy. Legacy source files (Windows-1252) that an editor or a model silently turns into UTF-8 are the failure this
 * exists for: the diff then touches every line with an accented character and the build or the next reader breaks.
 *
 * `expect` only matters when `before` is plain ASCII, where the bytes themselves do not say which encoding the repository uses for this
 * kind of file: `legacy` rejects non-ASCII UTF-8, `utf8` rejects legacy bytes, `preserve` accepts both.
 */
export function checkEncodingPreserved(before: Uint8Array, after: Uint8Array, options: { expect?: ExpectedEncoding } = {}): EncodingVerdict {
	const was = profileBytes(before);
	const now = profileBytes(after);
	const reasons: string[] = [];
	const expect = options.expect ?? "preserve";

	if (was.bom !== now.bom) reasons.push(was.bom ? `the ${was.bom} byte order mark was removed or changed` : `a ${now.bom} byte order mark was added`);
	if (!was.nul && now.nul) reasons.push("NUL bytes appeared (the file was probably written as UTF-16)");

	if (was.encoding === "legacy" && now.encoding === "utf8") reasons.push("the file was a legacy 8-bit file (e.g. Windows-1252) and is now UTF-8");
	if (was.encoding === "utf8" && now.encoding === "legacy") reasons.push("the file was UTF-8 and now contains bytes that are not valid UTF-8");
	if (was.encoding === "ascii") {
		if (now.encoding === "utf8" && expect === "legacy") reasons.push("non-ASCII text was written as UTF-8 into a file type that must stay in the legacy encoding");
		if (now.encoding === "legacy" && expect === "utf8") reasons.push("non-ASCII text was written as legacy 8-bit bytes into a file type that must be UTF-8");
	}
	if (now.replacementCharacters > was.replacementCharacters) reasons.push("U+FFFD replacement characters were introduced (text was decoded with the wrong encoding and written back)");

	if (was.lineEndings === "crlf" && (now.lineEndings === "lf" || now.lineEndings === "mixed")) reasons.push("the file used CRLF line endings throughout and now has bare LF lines");
	if (was.lineEndings === "lf" && (now.lineEndings === "crlf" || now.lineEndings === "mixed")) reasons.push("the file used LF line endings throughout and now has CRLF lines");

	return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

/** `*` within a path segment, `**` across segments, `?` one character; matched case-insensitively against a `/`-separated relative path. */
export function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i]!;
		if (char === "*") {
			if (glob[i + 1] === "*") {
				source += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
				i += glob[i + 2] === "/" ? 2 : 1;
			} else source += "[^/]*";
		} else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`, "i");
}

export const matchesAny = (path: string, globs: readonly string[]): boolean => globs.some((glob) => globToRegExp(glob).test(path.replaceAll("\\", "/")));

export interface EncodingPolicy {
	/** Paths whose non-ASCII text must stay in the legacy 8-bit encoding (the repository's convention for, say, C++ sources). */
	legacyGlobs: string[];
	utf8Globs: string[];
	/** Default true: a violation stops the push. */
	blockPush: boolean;
}

export const defaultEncodingPolicy = (): EncodingPolicy => ({ legacyGlobs: [], utf8Globs: [], blockPush: true });

export const expectationFor = (path: string, policy: EncodingPolicy): ExpectedEncoding => (matchesAny(path, policy.legacyGlobs) ? "legacy" : matchesAny(path, policy.utf8Globs) ? "utf8" : "preserve");
