import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Identity, SomeWorkClient } from "@somework/sdk";
import { apply, ApplyRefused, clientApi, refuseIfRisky, type ApplyOptions } from "./apply.ts";
import { postPlanComment } from "./comment.ts";
import { hasChanges, plan, toMarkdown, PLAN_MARKER } from "./plan.ts";
import { checkAgainstSamples, loadSamples } from "./samples.ts";
import { checkDuplicates, checkRule, loadRules, type Finding, type LoadedRule } from "./rules.ts";

export const USAGE = `somework-rules <command> [options]

Commands
  validate   check the rule files (schema, contract, conventions); exit 1 on errors
  plan       validate, then show what apply would change in the domain (markdown for a pull request comment, JSON for tools)
  apply      validate, then create, replace and delete rules so the domain matches the files
  comment    post (or update) a markdown file as the plan comment of a pull request: --file plan.md --repo owner/name --pr 12

Options
  --dir <path>            rules directory (default: rules)
  --strict                treat warnings as errors
  --out <file>            write the markdown (plan) or findings to a file
  --json-out <file>       write the machine-readable result to a file
  --dry-run               apply: show the plan, change nothing
  --no-prune              do not delete rules that no file declares
  --allow-empty           apply even when there are no rule files
  --allow-delete-many     apply even when it deletes more than --max-deletes rules (default 5)
  --max-deletes <n>

Environment
  SOMEWORK_URL, SOMEWORK_RULES_KEY_FILE (a principal with rules.manage; ops.read is enough for plan), SOMEWORK_CA_FILE, SOMEWORK_REQUIRE_TLS=1
  comment: GITHUB_TOKEN (pull requests: write), GITHUB_API_URL (default https://api.github.com)

Exit codes: 0 ok, 1 validation errors, 2 operational failure (usage, domain unreachable or unexpected answer, apply failed or did not converge)`;

export class UsageError extends Error {
	override readonly name = "UsageError";
}

const OPTIONS = {
	dir: { type: "string", default: "rules" },
	strict: { type: "boolean" },
	out: { type: "string" },
	"json-out": { type: "string" },
	"dry-run": { type: "boolean" },
	"no-prune": { type: "boolean" },
	"allow-empty": { type: "boolean" },
	"allow-delete-many": { type: "boolean" },
	"max-deletes": { type: "string" },
	file: { type: "string" },
	repo: { type: "string" },
	pr: { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;

export interface Io {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	env: NodeJS.ProcessEnv;
	/** Test seam: builds the domain API instead of reading the environment. */
	api?: () => Parameters<typeof clientApi>[0];
}

export function validateAll(dir: string, strict: boolean): { rules: LoadedRule[]; findings: Finding[]; ok: boolean } {
	const { rules, findings } = loadRules(dir);
	findings.push(...rules.flatMap(checkRule), ...checkDuplicates(rules));
	findings.push(...checkAgainstSamples(rules, loadSamples(join(dir, "samples"))));
	const ok = !findings.some((finding) => finding.level === "error" || (strict && finding.level === "warning"));
	return { rules, findings, ok };
}

const render = (finding: Finding) => `${finding.level.padEnd(7)} ${finding.file}: ${finding.message}`;

function findingsMarkdown(findings: Finding[], ok: boolean): string {
	const lines = [PLAN_MARKER, "### Rules plan", ""];
	lines.push(ok ? "The rule files are valid." : "**The rule files are not valid, so no plan was made.**", "");
	for (const finding of findings) lines.push(`- ${finding.level === "error" ? "❌" : finding.level === "warning" ? "⚠️" : "ℹ️"} \`${finding.file}\`: ${finding.message}`);
	return lines.join("\n");
}

function connect(io: Io) {
	if (io.api) return io.api();
	const url = io.env.SOMEWORK_URL;
	const keyFile = io.env.SOMEWORK_RULES_KEY_FILE;
	if (!url || !keyFile) throw new UsageError("SOMEWORK_URL and SOMEWORK_RULES_KEY_FILE must be set");
	return new SomeWorkClient({ baseUrl: url, identity: Identity.fromFile(keyFile), caFile: io.env.SOMEWORK_CA_FILE, requireTls: io.env.SOMEWORK_REQUIRE_TLS === "1" });
}

/** Runs one invocation; returns the exit code. */
export async function run(argv: string[], io: Io): Promise<number> {
	let parsed;
	try {
		parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
	} catch (error) {
		io.stderr(`${(error as Error).message}\n\n${USAGE}\n`);
		return 2;
	}
	const [command, ...extra] = parsed.positionals;
	const values = parsed.values;
	if (values.help || !command) {
		io.stdout(`${USAGE}\n`);
		return command || values.help ? 0 : 2;
	}
	if (!["validate", "plan", "apply", "comment"].includes(command) || extra.length > 0) {
		io.stderr(`unknown command or stray argument: ${[command, ...extra].join(" ")}\n\n${USAGE}\n`);
		return 2;
	}

	if (command === "comment") {
		const token = io.env.GITHUB_TOKEN;
		const pullRequest = Number(values.pr);
		if (!token || !values.file || !values.repo || !Number.isInteger(pullRequest) || pullRequest < 1) {
			io.stderr("comment needs --file, --repo, --pr and GITHUB_TOKEN\n");
			return 2;
		}
		try {
			const outcome = await postPlanComment({ apiUrl: io.env.GITHUB_API_URL ?? "https://api.github.com", token, repo: values.repo, pullRequest }, readFileSync(values.file, "utf8"));
			io.stdout(`plan comment ${outcome}\n`);
			return 0;
		} catch (error) {
			io.stderr(`failed: ${(error as Error).message}\n`);
			return 2;
		}
	}

	const dir = resolve(values.dir);
	const checked = validateAll(dir, values.strict === true);
	for (const finding of checked.findings) io.stderr(`${render(finding)}\n`);
	const writeJson = (value: unknown) => values["json-out"] && writeFileSync(values["json-out"], `${JSON.stringify(value, null, 2)}\n`);
	if (!checked.ok) {
		if (values.out) writeFileSync(values.out, `${findingsMarkdown(checked.findings, false)}\n`);
		writeJson({ ok: false, findings: checked.findings });
		io.stderr(`${checked.findings.filter((finding) => finding.level === "error").length} error(s) in the rule files\n`);
		return 1;
	}
	if (command === "validate") {
		if (values.out) writeFileSync(values.out, `${findingsMarkdown(checked.findings, true)}\n`);
		writeJson({ ok: true, rules: checked.rules.map(({ rule }) => rule.name), findings: checked.findings });
		io.stdout(`${checked.rules.length} rule file(s) valid${checked.findings.some((finding) => finding.level === "warning") ? `, ${checked.findings.filter((finding) => finding.level === "warning").length} warning(s)` : ""}\n`);
		return 0;
	}

	try {
		const api = clientApi(connect(io));
		const options: ApplyOptions = {
			dryRun: values["dry-run"],
			prune: !values["no-prune"],
			allowEmpty: values["allow-empty"],
			allowDeleteMany: values["allow-delete-many"],
			...(values["max-deletes"] ? { maxDeletes: Number(values["max-deletes"]) } : {}),
		};
		if (command === "plan") {
			const live = await api.list();
			const result = plan(checked.rules, live, { prune: options.prune });
			const markdown = toMarkdown(result);
			if (values.out) writeFileSync(values.out, `${markdown}\n`);
			writeJson({ ok: true, hasChanges: hasChanges(result), ...result });
			io.stdout(`${markdown}\n`);
			try {
				refuseIfRisky(result, checked.rules, live, options);
			} catch (refusal) {
				if (!(refusal instanceof ApplyRefused)) throw refusal;
				io.stderr(`note: apply would refuse this plan: ${refusal.message}\n`);
			}
			return 0;
		}
		const result = await apply(api, checked.rules, options);
		const markdown = toMarkdown(result.plan, { dryRun: options.dryRun });
		if (values.out) writeFileSync(values.out, `${markdown}\n`);
		writeJson({ ok: result.failures.length === 0, ...result });
		io.stdout(`${markdown}\n`);
		for (const failure of result.failures) io.stderr(`failed: ${failure.action} ${failure.name}: ${failure.error}\n`);
		if (!options.dryRun) io.stdout(result.converged ? `applied: the domain now matches the files\n` : `applied with problems: the domain does not match the files yet\n`);
		return options.dryRun || result.converged ? 0 : 2;
	} catch (error) {
		io.stderr(`${error instanceof ApplyRefused || error instanceof UsageError ? "refused" : "failed"}: ${(error as Error).message}\n`);
		return 2;
	}
}
