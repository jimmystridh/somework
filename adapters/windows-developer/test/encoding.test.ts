import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkEncodingPreserved, defaultEncodingPolicy, expectationFor, globToRegExp, matchesAny, profileBytes } from "../src/encoding.ts";

// Windows-1252 and latin-1 agree on a, a with ring, o with diaeresis: bytes E4 E5 F6
const cp1252 = (text: string): Uint8Array => Buffer.from(text, "latin1");
const utf8 = (text: string): Uint8Array => Buffer.from(text, "utf8");
const reasons = (verdict: ReturnType<typeof checkEncodingPreserved>): string[] => (verdict.ok ? [] : verdict.reasons);

describe("checkEncodingPreserved", () => {
	const before = cp1252("// Vi s\u00e4ger: h\u00e5ll \u00f6ver\r\nint main() {}\r\n");

	it("accepts an edit that keeps a Windows-1252 file in Windows-1252 and CRLF", () => {
		const after = cp1252("// Vi s\u00e4ger: h\u00e5ll \u00f6ver\r\nint main() { return 0; }\r\n// \u00e4ndrad\r\n");
		assert.deepEqual(checkEncodingPreserved(before, after), { ok: true });
	});

	it("rejects a Windows-1252 file that was rewritten as UTF-8", () => {
		const after = utf8("// Vi s\u00e4ger: h\u00e5ll \u00f6ver\r\nint main() {}\r\n");
		assert.match(reasons(checkEncodingPreserved(before, after)).join("|"), /legacy 8-bit file.*now UTF-8/);
	});

	it("rejects text that was decoded as UTF-8 and written back with replacement characters", () => {
		const mangled = utf8(Buffer.from(before).toString("utf8")); // what a UTF-8-only editor does to those bytes
		const found = reasons(checkEncodingPreserved(before, mangled)).join("|");
		assert.match(found, /now UTF-8/);
		assert.match(found, /U\+FFFD/);
	});

	it("rejects an added or removed byte order mark", () => {
		assert.match(reasons(checkEncodingPreserved(utf8("hej\n"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8("hej\n")]))).join("|"), /utf8 byte order mark was added/);
		assert.match(reasons(checkEncodingPreserved(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8("h\u00e5\n")]), utf8("h\u00e5\n"))).join("|"), /byte order mark was removed/);
	});

	it("rejects a file that lost its CRLF line endings, or gained them", () => {
		assert.match(reasons(checkEncodingPreserved(cp1252("a\r\nb\r\n"), cp1252("a\r\nb\nc\r\n"))).join("|"), /CRLF line endings throughout and now has bare LF/);
		assert.match(reasons(checkEncodingPreserved(utf8("a\nb\n"), utf8("a\r\nb\r\n"))).join("|"), /LF line endings throughout and now has CRLF/);
		assert.deepEqual(checkEncodingPreserved(cp1252("a\r\nb\nc\r\n"), cp1252("a\nb\r\nc\n")), { ok: true }, "a file that already mixed them is not held to either");
	});

	it("rejects UTF-16 output (NUL bytes) and UTF-8 turned into legacy bytes", () => {
		assert.match(reasons(checkEncodingPreserved(utf8("abc\n"), Buffer.from("\u00ff\u00fea\u0000b\u0000", "latin1"))).join("|"), /NUL bytes appeared/);
		assert.match(reasons(checkEncodingPreserved(utf8("h\u00e5\n"), cp1252("h\u00e5\n"))).join("|"), /was UTF-8 and now contains bytes that are not valid UTF-8/);
	});

	it("leaves a UTF-8 file in UTF-8 alone and allows edits that stay ASCII", () => {
		assert.deepEqual(checkEncodingPreserved(utf8("h\u00e5\n"), utf8("h\u00e5 och \u00e4\n")), { ok: true });
		assert.deepEqual(checkEncodingPreserved(utf8("plain\n"), utf8("plain\nmore\n")), { ok: true });
	});

	it("decides an ASCII file's first accent by the repository's expectation", () => {
		const ascii = utf8("plain\r\n");
		const withUtf8 = utf8("pl\u00e5in\r\n");
		const withLegacy = cp1252("pl\u00e5in\r\n");
		assert.deepEqual(checkEncodingPreserved(ascii, withUtf8), { ok: true });
		assert.deepEqual(checkEncodingPreserved(ascii, withLegacy), { ok: true });
		assert.match(reasons(checkEncodingPreserved(ascii, withUtf8, { expect: "legacy" })).join("|"), /must stay in the legacy encoding/);
		assert.deepEqual(checkEncodingPreserved(ascii, withLegacy, { expect: "legacy" }), { ok: true });
		assert.match(reasons(checkEncodingPreserved(ascii, withLegacy, { expect: "utf8" })).join("|"), /must be UTF-8/);
	});

	it("profiles bytes", () => {
		assert.deepEqual(profileBytes(cp1252("h\u00e5\r\n")), { encoding: "legacy", bom: undefined, lineEndings: "crlf", nul: false, replacementCharacters: 0 });
		assert.equal(profileBytes(utf8("h\u00e5\n")).encoding, "utf8");
		assert.equal(profileBytes(utf8("abc")).lineEndings, "none");
	});
});

describe("globs", () => {
	it("match like the usual ones", () => {
		assert.equal(globToRegExp("**/*.cpp").test("Source/Legacy/a.cpp"), true);
		assert.equal(globToRegExp("**/*.cpp").test("a.cpp"), true);
		assert.equal(globToRegExp("**/*.cpp").test("a.cppx"), false);
		assert.equal(globToRegExp("src/*.h").test("src/deep/a.h"), false);
		assert.equal(globToRegExp("src/**/*.h").test("src/deep/er/a.h"), true);
		assert.equal(globToRegExp("*.RC").test("app.rc"), true, "case-insensitive");
		assert.equal(matchesAny("src\\x\\a.cpp", ["**/*.cpp"]), true, "backslashes are normalised");
	});

	it("pick the expectation for a path", () => {
		const policy = { ...defaultEncodingPolicy(), legacyGlobs: ["**/*.cpp"], utf8Globs: ["**/*.md"] };
		assert.equal(expectationFor("a/b.cpp", policy), "legacy");
		assert.equal(expectationFor("README.md", policy), "utf8");
		assert.equal(expectationFor("x.txt", policy), "preserve");
	});
});
