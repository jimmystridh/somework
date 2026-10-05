import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuleSpec, RuleView } from "@somework/sdk";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");
export const realRules = join(repoRoot, "rules");

export const REVIEW_YAML = `name: pr-review
description: Review every opened pull request.
owner: automation/pr-review
selector: github.pull_request.opened
where:
  - path: /data/draft
    equals: false
wake: false
reaction:
  capability:
    id: code.review
    version: 3
  input:
    repository:
      url: \${/data/repository/cloneUrl}
      ref: refs/pull/\${/data/number}/head
    pullRequest: \${/data/number}
    budget:
      maxTokens: 200000
      maxMinutes: 20
  budget:
    maxTokens: 200000
    maxMinutes: 20
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
	lastFiredAt: null,
	counters: { fired: 0, skipped: { duplicate: 0, depth: 0, rate: 0, denied: 0, approval: 0, error: 0 } },
	...spec,
});
