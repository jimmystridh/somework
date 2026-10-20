import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const wrapper = readFileSync(fileURLToPath(new URL("../sandbox/gh", import.meta.url)), "utf8");
const dir = mkdtempSync(join(tmpdir(), "gh-wrapper-"));
// the real binary lives at /usr/local/lib/gh/gh in the image: here a stand-in that prints what it was given
const fake = join(dir, "fake-gh");
writeFileSync(fake, '#!/bin/sh\necho "token=${GH_TOKEN:-none} args=$* prompt=$GH_PROMPT_DISABLED"\n');
chmodSync(fake, 0o755);
const script = join(dir, "gh");
writeFileSync(script, wrapper.replace("/usr/local/lib/gh/gh", fake));
chmodSync(script, 0o755);
const run = (env: Record<string, string>, ...args: string[]) => execFileSync("sh", [script, ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" }).trim();

describe("the sandbox's gh wrapper", () => {
	it("reads the token from the mounted file and passes the arguments through", () => {
		const file = join(dir, "token");
		writeFileSync(file, "ghp_readonly_example\n");
		assert.equal(run({ GH_TOKEN_FILE: file }, "pr", "view", "5"), "token=ghp_readonly_example args=pr view 5 prompt=1");
	});

	it("stays unauthenticated when the mount is empty (/dev/null) or missing, and never overrides a token that is already set", () => {
		assert.match(run({ GH_TOKEN_FILE: "/dev/null" }, "auth", "status"), /^token=none /);
		assert.match(run({ GH_TOKEN_FILE: join(dir, "missing") }, "auth", "status"), /^token=none /);
		const file = join(dir, "other");
		writeFileSync(file, "from_file");
		assert.match(run({ GH_TOKEN_FILE: file, GH_TOKEN: "from_env" }, "x"), /^token=from_env /);
	});
});
