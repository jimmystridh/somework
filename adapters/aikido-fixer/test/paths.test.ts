import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { globToRegExp, matchesAny } from "../src/paths.ts";
import { DEFAULT_PROTECTED_PATHS } from "../src/settings.ts";

describe("protected paths", () => {
	const protectedPaths = DEFAULT_PROTECTED_PATHS;
	it("catches workflows, pipelines, code owners, keys and environment files, wherever they are", () => {
		for (const path of [".github/workflows/ci.yml", ".github/CODEOWNERS", ".woodpecker/deploy.yaml", ".gitlab-ci.yml", "CODEOWNERS", "docs/CODEOWNERS", ".env", "app/.env", "app/.env.production", "certs/server.pem", "a/b/c/private.key", "id_rsa", "x/id_rsa.pub"]) {
			assert.ok(matchesAny(path, protectedPaths), path);
		}
	});
	it("leaves ordinary source and lockfiles alone", () => {
		for (const path of ["package.json", "package-lock.json", "src/app.ts", "src/env.ts", "docs/github.md", "environment.txt", "keys.md", "x/.gitlab-ci.yml.bak"]) assert.equal(matchesAny(path, protectedPaths), undefined, path);
	});
	it("normalises Windows separators and a leading ./", () => {
		assert.ok(matchesAny(".github\\workflows\\ci.yml", protectedPaths));
		assert.ok(matchesAny("./.github/workflows/ci.yml", protectedPaths));
	});
	it("treats a single star as one path segment and a double star as any depth", () => {
		assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
		assert.ok(!globToRegExp("src/*.ts").test("src/x/a.ts"));
		assert.ok(globToRegExp("src/**").test("src/x/y/a.ts"));
		assert.ok(globToRegExp("a.b").test("a.b") && !globToRegExp("a.b").test("axb"));
	});
});
