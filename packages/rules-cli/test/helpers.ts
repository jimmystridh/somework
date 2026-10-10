import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuleSpec, RuleView } from "@somework/sdk";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");
export const realRules = join(repoRoot, "rules");

export const REVIEW_YAML = `name: pr-review
description: Wake the reviewer for every opened pull request.
owner: agent/reviewer
selector: github.pull_request.opened
where:
  - path: /data/draft
    equals: false
wake: true
`;

/** A rules directory with the real schema and the given files. */
export function rulesDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "rules-cli-"));
	copyFileSync(join(realRules, "schema.json"), join(dir, "schema.json"));
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

export const view = (name: string, spec: Partial<RuleView> & Pick<RuleSpec, "owner" | "selector" | "wake">): RuleView => ({
	name,
	description: "",
	where: [],
	status: "active",
	...spec,
});
