import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { describe, it } from "node:test";

const repository = join(import.meta.dirname, "..");
const dockerfile = readFileSync(join(repository, "dashboard", "Dockerfile"), "utf8");
const lines = dockerfile.split("\n");
const at = (pattern: RegExp): number => lines.findIndex((line) => pattern.test(line));

/** The crates (relative to the repository root) that the dashboard workspace reaches through `path =` dependencies. */
function pathCrates(): string[] {
	const seen = new Set<string>();
	const visit = (directory: string): void => {
		if (seen.has(directory)) return;
		seen.add(directory);
		const manifest = readFileSync(join(repository, directory, "Cargo.toml"), "utf8");
		for (const [, relative] of manifest.matchAll(/path\s*=\s*"([^"]+)"/g)) visit(normalize(join(directory, relative!)));
	};
	for (const member of ["shared", "server", "ui"]) visit(`dashboard/${member}`);
	return [...seen].filter((directory) => directory.startsWith("crates/"));
}

describe("dashboard/Dockerfile", () => {
	it("compiles the dependencies from the manifests and the lockfile in a layer before any source is copied", () => {
		const dependencies = at(/^RUN cargo build /);
		assert.ok(dependencies > 0);
		assert.ok(at(/^COPY dashboard\/server dashboard\/server$/) > dependencies, "the sources are copied after the dependency build");
		const before = lines.slice(0, dependencies).join("\n");
		assert.match(before, /COPY dashboard\/Cargo\.toml dashboard\/Cargo\.lock dashboard\//);
		for (const member of ["shared", "server", "ui"]) assert.match(before, new RegExp(`COPY dashboard/${member}/Cargo\\.toml `));
		const copies = lines.slice(0, dependencies).filter((line) => line.startsWith("COPY "));
		assert.ok(
			copies.every((line) => /Cargo\.(toml|lock)/.test(line)),
			`only manifests and the lockfile are copied before the dependency layer:\n${copies.join("\n")}`,
		);
	});

	it("copies the manifest and, later, the sources of every crate the dashboard reaches by path", () => {
		const crates = pathCrates();
		assert.deepEqual([...crates].sort(), ["crates/somework-client", "crates/somework-core"], "a new path dependency has to be added to the Dockerfile and to this list");
		const dependencies = at(/^RUN cargo build /);
		for (const crate of crates) {
			const manifest = at(new RegExp(`^COPY ${crate}/Cargo\\.toml ${crate}/Cargo\\.toml$`));
			assert.ok(manifest >= 0 && manifest < dependencies, `${crate}: the manifest comes before the dependency layer`);
			assert.ok(at(new RegExp(`^COPY ${crate} ${crate}$`)) > dependencies, `${crate}: the sources come after it`);
		}
	});

	it("touches the real sources in the step that builds them, so cargo does not keep the stubs it built for the dependency layer", () => {
		const sources = at(/^COPY dashboard\/server dashboard\/server$/);
		const final = lines.findIndex((line, index) => index > sources && line.startsWith("RUN "));
		const step = lines.slice(final, final + 2).join(" ");
		assert.match(step, /find .*-name '\*\.rs' -exec touch \{\} \+/);
		assert.match(step, /&& cargo build --locked --release --package fleet-server/);
		for (const directory of ["../crates/somework-core", "../crates/somework-client", "shared", "server"]) assert.ok(step.includes(directory), directory);
	});

	it("still makes the same image: the binary and the UI bundle on the pinned bases, one user, the same port and command", () => {
		assert.match(dockerfile, /COPY --from=builder \/build\/dashboard\/target\/release\/fleet-server \/app\/fleet-server\nCOPY dashboard\/bundle \/app\/public\nUSER 1000:1000\nEXPOSE 8443\nCMD \["\/app\/fleet-server"\]/);
		const bases = lines.filter((line) => line.startsWith("FROM "));
		assert.equal(bases.length, 2);
		assert.ok(bases.every((line) => line.includes("@sha256:")), "the base images stay pinned by digest");
	});

	it("is built from the repository root with a context that holds what it copies", () => {
		const ignore = readFileSync(join(repository, "dashboard", "Dockerfile.dockerignore"), "utf8");
		for (const kept of ["!Cargo.toml", "!crates", "!dashboard"]) assert.ok(ignore.split("\n").includes(kept), kept);
		assert.match(dockerfile, /docker build -f dashboard\/Dockerfile -t agent-cluster-fleet:<version> \./);
	});
});
