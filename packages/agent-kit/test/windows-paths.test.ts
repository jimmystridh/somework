import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfinementError, isInside, resolveInside } from "../src/windows/paths.ts";

const ROOT = "C:\\somework\\ws";
const win = (path: string, cwd?: string) => resolveInside(ROOT, path, { flavour: "win32", cwd });
const refused = (path: string, cwd?: string) => assert.throws(() => win(path, cwd), ConfinementError, path);

describe("resolveInside (Windows semantics, on any OS)", () => {
	it("accepts paths below the root in every spelling Windows accepts", () => {
		assert.equal(win("a\\b.txt"), "C:\\somework\\ws\\a\\b.txt");
		assert.equal(win("a/b.txt"), "C:\\somework\\ws\\a\\b.txt");
		assert.equal(win("./a/../b"), "C:\\somework\\ws\\b");
		assert.equal(win("C:\\somework\\ws\\x\\y"), "C:\\somework\\ws\\x\\y");
		assert.equal(win("C:/somework/ws/x"), "C:\\somework\\ws\\x");
		assert.equal(win("c:\\SOMEWORK\\WS\\x"), "c:\\SOMEWORK\\WS\\x", "case-insensitive on Windows");
		assert.equal(win("\\somework\\ws\\x"), "C:\\somework\\ws\\x", "a rooted path takes the root's drive and is judged after resolution");
		assert.equal(win("."), "C:\\somework\\ws");
		assert.equal(win("file~1.txt.bak"), "C:\\somework\\ws\\file~1.txt.bak", "a tilde that is not an 8.3 name is fine");
	});

	it("resolves relative paths against the working directory, which must itself be inside", () => {
		assert.equal(win("x", "C:\\somework\\ws\\sub"), "C:\\somework\\ws\\sub\\x");
		assert.equal(win("..\\x", "C:\\somework\\ws\\sub"), "C:\\somework\\ws\\x");
		refused("..\\..\\x", "C:\\somework\\ws\\sub");
		refused("x", "C:\\elsewhere");
	});

	it("refuses to leave the root", () => {
		for (const path of ["..", "..\\x", "a\\..\\..\\x", "a/../../x", "C:\\", "C:\\somework", "C:\\somework\\other", "D:\\somework\\ws\\x", "\\x"]) refused(path);
	});

	it("refuses the sibling that merely shares a prefix with the root", () => {
		refused("C:\\somework\\ws2\\a");
		refused("C:\\somework\\ws.evil\\a");
		refused("..\\ws2\\a");
	});

	it("refuses UNC, device and extended-length forms", () => {
		for (const path of ["\\\\server\\share\\x", "//server/share/x", "\\\\?\\C:\\somework\\ws\\x", "\\\\.\\pipe\\x", "\\\\?\\UNC\\server\\share"]) refused(path);
	});

	it("refuses drive-relative paths and alternate data streams", () => {
		for (const path of ["C:x", "C:", "D:x\\y", "a.txt:stream", "a.txt::$DATA", "dir\\a.txt:hidden:$DATA"]) refused(path);
	});

	it("refuses names Windows rewrites or reserves", () => {
		for (const path of ["a.", "a ", "dir.\\x", "dir \\x", "con", "NUL.txt", "aux", "com1", "LPT9.log", "x\\prn", "CONIN$"]) refused(path);
	});

	it("refuses 8.3 short names, which could alias a path the name check cannot compare", () => {
		for (const path of ["PROGRA~1", "docume~1.txt", "x\\LONGNA~2\\y", "Progra~1\\Git"]) refused(path);
	});

	it("refuses characters Windows rejects, NUL, empty paths, and the home and file: forms", () => {
		for (const path of ["a<b", "a>b", 'a"b', "a|b", "a?b", "a*b", "a\u0001b", "a\u0000b", "", "~", "~/x", "~\\x", "file:///c:/x", "FILE:x"]) refused(path);
	});

	it("needs an absolute root", () => {
		assert.throws(() => resolveInside("relative\\root", "x", { flavour: "win32" }), ConfinementError);
	});
});

describe("isInside", () => {
	it("compares by path segment, not by string prefix, and ignores case on Windows", () => {
		assert.equal(isInside(ROOT, ROOT, "win32"), true);
		assert.equal(isInside(ROOT, "C:\\somework\\ws\\a", "win32"), true);
		assert.equal(isInside(ROOT, "c:\\SomeWork\\WS\\a", "win32"), true);
		assert.equal(isInside(ROOT, "C:\\somework\\ws2", "win32"), false);
		assert.equal(isInside(ROOT, "C:\\somework", "win32"), false);
		assert.equal(isInside(ROOT, "D:\\somework\\ws", "win32"), false);
	});

	it("applies the posix rules for posix paths", () => {
		assert.equal(isInside("/srv/ws", "/srv/ws/a", "posix"), true);
		assert.equal(isInside("/srv/ws", "/srv/ws2", "posix"), false);
		assert.equal(isInside("/srv/ws", "/srv/WS/a", "posix"), false, "case matters on posix");
		assert.equal(resolveInside("/srv/ws", "a/../b", { flavour: "posix" }), "/srv/ws/b");
		assert.throws(() => resolveInside("/srv/ws", "../x", { flavour: "posix" }), ConfinementError);
		assert.throws(() => resolveInside("/srv/ws", "~/x", { flavour: "posix" }), ConfinementError);
	});
});
