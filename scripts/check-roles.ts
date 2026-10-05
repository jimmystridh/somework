// Fails when code crosses a layer boundary of the TypeScript workspace:
//   adapters/<role>      may use @somework/sdk and @somework/agent-kit, never another role
//   packages/agent-kit   may use @somework/sdk, never a role
//   sdk/typescript       depends on neither
// Usage: node scripts/check-roles.ts   (exit code 1 lists the offending imports)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIRS = ["src", "test", "extension", "examples"];
const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

export interface Violation {
	file: string;
	specifier: string;
	reason: string;
}

const dirs = (path: string): string[] => {
	try {
		return readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory() && name !== "node_modules");
	} catch {
		return [];
	}
};

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (path: string) => {
		for (const name of readdirSync(path)) {
			if (name === "node_modules") continue;
			const full = join(path, name);
			if (statSync(full).isDirectory()) walk(full);
			else if (/\.(ts|mts|js|mjs)$/.test(name)) out.push(full);
		}
	};
	for (const sub of SOURCE_DIRS) {
		try {
			walk(join(dir, sub));
		} catch {
			// the role has no such directory
		}
	}
	return out;
}

export function findViolations(root: string): Violation[] {
	const roles = dirs(join(root, "adapters")).map((name) => ({ name, dir: join(root, "adapters", name), pkg: JSON.parse(readFileSync(join(root, "adapters", name, "package.json"), "utf8")).name as string }));
	const kitDir = join(root, "packages", "agent-kit");
	const sdkDir = join(root, "sdk", "typescript");
	const violations: Violation[] = [];

	const check = (ownerDir: string, forbidden: { dir: string; pkg?: string; label: string }[]) => {
		for (const file of sourceFiles(ownerDir)) {
			for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
				const specifier = match[1]!;
				for (const other of forbidden) {
					const byName = other.pkg !== undefined && (specifier === other.pkg || specifier.startsWith(`${other.pkg}/`));
					const byPath = specifier.startsWith(".") && (resolve(dirname(file), specifier) + sep).startsWith(other.dir + sep);
					if (byName || byPath) violations.push({ file: relative(root, file), specifier, reason: `imports ${other.label}` });
				}
			}
		}
	};

	for (const role of roles) check(role.dir, roles.filter((other) => other.name !== role.name).map((other) => ({ dir: other.dir, pkg: other.pkg, label: `the role ${other.name}` })));
	check(kitDir, roles.map((role) => ({ dir: role.dir, pkg: role.pkg, label: `the role ${role.name}` })));
	check(sdkDir, [...roles.map((role) => ({ dir: role.dir, pkg: role.pkg, label: `the role ${role.name}` })), { dir: kitDir, pkg: "@somework/agent-kit", label: "the agent kit" }]);
	return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const violations = findViolations(root);
	for (const v of violations) console.error(`${v.file}: "${v.specifier}" ${v.reason}`);
	if (violations.length > 0) {
		console.error(`\n${violations.length} boundary violation(s): code shared by two roles belongs in packages/agent-kit.`);
		process.exit(1);
	}
	console.log("workspace boundaries ok");
}
