import { posix, win32 } from "node:path";

/** Which path rules apply. The production service runs `win32`; tests exercise `win32` on any OS and `posix` against a real directory. */
export type Flavour = "win32" | "posix";

export const nativeFlavour = (): Flavour => (process.platform === "win32" ? "win32" : "posix");

export class ConfinementError extends Error {
	override readonly name = "ConfinementError";
}

export interface ResolveOptions {
	/** Directory that relative paths are resolved against. It must itself be inside `root`. Default: `root`. */
	cwd?: string;
	flavour?: Flavour;
}

const RESERVED_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/** 8.3 short names (`PROGRA~1`, `DOCUME~1.TXT`): the same file under a name the confinement cannot compare. */
const SHORT_NAME = /^[^.]{1,8}~[0-9]+(\.[^.]{0,3})?$/;
const FORBIDDEN_CHARACTERS = /[<>"|?*\u0000-\u001f]/;

const api = (flavour: Flavour) => (flavour === "win32" ? win32 : posix);

/** True when `candidate` is `root` or below it. Comparison follows the flavour (case-insensitive on Windows). */
export function isInside(root: string, candidate: string, flavour: Flavour = nativeFlavour()): boolean {
	const path = api(flavour);
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	if (relative === "") return true;
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function rejectWindowsForms(path: string): void {
	const slashes = path.replaceAll("/", "\\");
	if (slashes.startsWith("\\\\")) throw new ConfinementError(`UNC, device and extended-length paths are not allowed: ${path}`);
	const drive = /^[A-Za-z]:/.exec(path);
	if (drive && path.length > 2 && path[2] !== "\\" && path[2] !== "/") throw new ConfinementError(`drive-relative paths are not allowed: ${path}`);
	if (drive && path.length === 2) throw new ConfinementError(`drive-relative paths are not allowed: ${path}`);
	const afterDrive = drive ? path.slice(2) : path;
	if (afterDrive.includes(":")) throw new ConfinementError(`alternate data streams and stray colons are not allowed: ${path}`);
	for (const segment of slashes.split("\\")) {
		if (segment === "" || segment === "." || segment === "..") continue;
		if (/[. ]$/.test(segment)) throw new ConfinementError(`segments ending in a dot or a space are not allowed (Windows drops them): ${path}`);
		if (FORBIDDEN_CHARACTERS.test(segment)) throw new ConfinementError(`characters that are not valid in Windows file names: ${path}`);
		if (RESERVED_DEVICE.test(segment)) throw new ConfinementError(`reserved device names are not allowed: ${path}`);
		if (SHORT_NAME.test(segment)) throw new ConfinementError(`8.3 short names are not allowed (use the long name): ${path}`);
	}
}

/**
 * The absolute path `path` names, or a `ConfinementError` when it is not provably inside `root`.
 * Pure: it looks only at the strings. The environment adds a real-path check (junctions and symbolic links) on top.
 *
 * Refused outright, before any resolution: `~` and `file:` forms (the shell environment would expand them), NUL, UNC / `\\?\` / `\\.\`
 * prefixes, drive-relative (`C:foo`) paths, alternate data streams, trailing dots and spaces, reserved device names, characters Windows
 * rejects, and 8.3 short names. Everything else is resolved against `cwd` (or `root`) and compared with `root`.
 */
export function resolveInside(root: string, path: string, options: ResolveOptions = {}): string {
	const flavour = options.flavour ?? nativeFlavour();
	const impl = api(flavour);
	if (typeof path !== "string" || path.length === 0) throw new ConfinementError("an empty path is not allowed");
	if (path.includes("\u0000")) throw new ConfinementError("NUL in a path is not allowed");
	if (path === "~" || path.startsWith("~/") || path.startsWith("~\\") || /^file:/i.test(path)) throw new ConfinementError(`home and file: forms are not allowed: ${path}`);
	if (!impl.isAbsolute(root)) throw new ConfinementError(`the workspace root must be an absolute path: ${root}`);
	if (flavour === "win32") rejectWindowsForms(path);

	const base = options.cwd ?? root;
	if (!isInside(root, base, flavour)) throw new ConfinementError(`the working directory is outside the workspace root: ${base}`);
	const resolved = impl.resolve(base, path);
	if (!isInside(root, resolved, flavour)) throw new ConfinementError(`outside the workspace root: ${path}`);
	return resolved;
}
