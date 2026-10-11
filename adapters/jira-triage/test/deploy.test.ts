import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import card from "../card.json" with { type: "json" };
import { TOPICS } from "../src/seed.ts";

const role = new URL("..", import.meta.url).pathname;
const adapters = join(role, "..");
const read = (...path: string[]) => readFileSync(join(role, ...path), "utf8");
const compose = read("deploy", "compose.yaml");
const example = read("deploy", ".env.example");

const hostPorts = (text: string): string[] => [...text.matchAll(/ports:\s*\["[^"]*?:?(\d+):\d+"\]/g)].map((match) => match[1]!);

describe("the compose file", () => {
	it("publishes its health port on 8085, which no other stack of the host uses", () => {
		assert.deepEqual(hostPorts(compose), ["8085"]);
		for (const other of readdirSync(adapters)) {
			if (other === "jira-triage") continue;
			try {
				assert.deepEqual(hostPorts(readFileSync(join(adapters, other, "deploy", "compose.yaml"), "utf8")).filter((port) => port === "8085"), [], `${other} already uses 8085`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		assert.match(compose, /8081 developer, 8082 reviewer, 8083 Aikido fixer, 8084 Datadog triage/);
	});

	it("keeps the sandbox on an internal network alone: no egress service, no proxy, no route out", () => {
		assert.match(compose, /networks:\n  sandbox-net:\n    internal: true/);
		const sandbox = compose.slice(compose.indexOf("\n  sandbox:"), compose.indexOf("\n  # One-shot"));
		assert.match(sandbox, /networks: \[sandbox-net\]/);
		assert.doesNotMatch(sandbox, /outside|PROXY|egress/i);
		assert.doesNotMatch(compose, /\n  egress:/);
		assert.match(compose, /image: somework-pi-sandbox:\$\{SANDBOX_VERSION:\?/);
	});

	it("is hardened like the other stacks", () => {
		for (const line of ["read_only: true", "cap_drop: [ALL]", 'security_opt: ["no-new-privileges:true"]', "privileged: false", "restart: unless-stopped"]) assert.ok(compose.includes(line), line);
		assert.match(compose, /user: "10001:10001"/);
		assert.match(compose, /image: somework-jira-triage:\$\{TRIAGE_VERSION:\?/);
		assert.match(compose, /name: somework-jira-triage/);
	});

	it("takes the Jira credentials from files, with the same names the QA role uses, and never from a value in the environment", () => {
		for (const name of ["JIRA_URL", "JIRA_TOKEN_FILE", "JIRA_PFX_FILE", "JIRA_PFX_PASSWORD_FILE", "JIRA_CA_FILE"]) assert.match(compose, new RegExp(`\\n      ${name}: `), name);
		assert.doesNotMatch(compose, /JIRA_TOKEN:|JIRA_PFX_PASSWORD:|SLACK_BOT_TOKEN:|SLACK_APP_TOKEN:|TELEGRAM_BOT_TOKEN:/);
		for (const mount of ["./secrets/jira-token:/run/secrets/jira-token:ro", "./secrets/jira.pfx:/run/secrets/jira.pfx:ro", "./secrets/jira-pfx-password:/run/secrets/jira-pfx-password:ro"]) assert.ok(compose.includes(mount), mount);
	});

	it("leaves Telegram, Slack, the Jira CA and the observe tools off by mounting /dev/null until they are configured", () => {
		for (const variable of ["TELEGRAM_TOKEN_HOST", "SLACK_BOT_TOKEN_HOST", "SLACK_APP_TOKEN_HOST", "JIRA_CA_HOST", "GRAFANA_TOKEN_HOST", "GRAFANA_CA_HOST"]) assert.match(compose, new RegExp(`\\$\\{${variable}:-/dev/null\\}`), variable);
		for (const name of ["SLACK_BOT_TOKEN_FILE", "SLACK_APP_TOKEN_FILE", "SLACK_ALLOWED_USER_IDS", "SLACK_ALLOWED_CHANNELS", "TELEGRAM_BOT_TOKEN_FILE", "TELEGRAM_ALLOWED_USER_IDS"]) assert.match(compose, new RegExp(`\\n      ${name}: `), name);
	});

	it("starts with the safe settings: a dry run is one switch away and the handler is seeded", () => {
		assert.match(compose, /TRIAGE_DRY_RUN: \$\{TRIAGE_DRY_RUN:-0\}/);
		assert.match(example, /^TRIAGE_DRY_RUN=1$/m);
		assert.match(compose, /EVENTS_ENABLED: "1"/);
		assert.match(compose, /JIRA_PROJECTS: \$\{JIRA_PROJECTS:-SAD\}/);
		assert.match(compose, /TRIAGE_ENRICH: \$\{TRIAGE_ENRICH:-1\}/);
		assert.match(compose, /TRIAGE_DEVELOPER_AGENT: \$\{TRIAGE_DEVELOPER_AGENT:-agent\/pi-agent\}/);
	});

	it("is explained: every required variable of the compose file is in the example environment, and the example holds no secret", () => {
		for (const match of compose.matchAll(/\$\{([A-Z_]+):\?/g)) assert.match(example, new RegExp(`^${match[1]}=`, "m"), match[1]);
		assert.doesNotMatch(example, /xox[bpa]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|pat_[A-Za-z0-9_]{10,}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}/);
		assert.doesNotMatch(compose, /xox[bpa]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|-----BEGIN/);
	});
});

describe("the image", () => {
	const dockerfile = read("Dockerfile");

	it("installs only this role's tree from the workspace's lockfile and checks at build time that everything imports and the handler renders", () => {
		assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts -w @somework\/jira-triage/);
		for (const file of ["adapters/jira-triage/src", "adapters/jira-triage/handlers", "adapters/jira-triage/card.json"]) assert.ok(dockerfile.includes(`COPY ${file} /app/${file}`), file);
		for (const module of ["./src/profile.ts", "./src/hooks.ts", "./src/settings.ts", "./src/seed.ts", "./src/engine.ts", "./src/chat.ts"]) assert.ok(dockerfile.includes(`'${module}'`), module);
		assert.match(dockerfile, /node --check \/tmp\/handler-check\.mjs/);
		assert.match(dockerfile, /USER 10001:10001/);
		assert.match(dockerfile, /CMD \["node", "src\/main\.ts"\]/);
	});

	it("is one the workspace can install: the package declares what the kit's roles declare", () => {
		const own = JSON.parse(read("package.json"));
		const aikido = JSON.parse(readFileSync(join(adapters, "aikido-fixer", "package.json"), "utf8"));
		assert.equal(own.name, "@somework/jira-triage");
		assert.deepEqual(own.dependencies, aikido.dependencies);
		assert.deepEqual(own.scripts, aikido.scripts);
		assert.equal(own.type, "module");
	});
});

describe("the rules", () => {
	const repositoryRules = join(role, "..", "..", "rules");
	const held = join(role, "deploy", "rules");
	/** The rules sit in deploy/rules until the agent is enrolled, then move to the repository's rules directory. */
	const places = [held, repositoryRules].filter((dir) => readdirSync(dir).some((file) => file.startsWith("jira-triage-")));
	const dir = places[0]!;
	const files = readdirSync(dir).filter((file) => file.startsWith("jira-triage-")).sort();
	const field = (text: string, name: string) => new RegExp(`^${name}: (.*)$`, "m").exec(text)?.[1]?.trim();

	it("are in one place, held in deploy/rules until the owner is enrolled and in rules/ after that", () => {
		assert.equal(places.length, 1);
	});

	it("are one subscription per selector, each owned by the agent of the card, named like its file, and always waking", () => {
		assert.deepEqual(files, ["jira-triage-comment.yaml", "jira-triage-created.yaml", "jira-triage-updated.yaml"]);
		const selectors: string[] = [];
		for (const file of files) {
			const text = readFileSync(join(dir, file), "utf8");
			assert.equal(field(text, "name"), file.replace(/\.yaml$/, ""));
			assert.equal(field(text, "owner"), card.agentId);
			assert.equal(field(text, "wake"), "true");
			assert.equal(field(text, "status"), undefined, "the domain owns whether a rule is paused");
			assert.ok((field(text, "description") ?? "").length <= 502, "the description fits the schema");
			selectors.push(field(text, "selector")!);
		}
		assert.deepEqual(selectors.sort(), [...TOPICS].sort());
	});

	it("have a recorded event of each topic next to the other samples", () => {
		for (const topic of TOPICS) {
			const sample = JSON.parse(readFileSync(join(role, "..", "..", "rules", "samples", `${topic}.json`), "utf8"));
			assert.equal(sample.topic, topic);
			assert.equal(sample.data.issue.key, "SAD-123");
			assert.equal(typeof sample.data.issue.type, "string");
		}
	});
});

describe("the Slack app", () => {
	const manifest = read("deploy", "slack-app-manifest.yaml");
	const shared = readFileSync(join(role, "..", "..", "packages", "agent-kit", "docs", "slack-app-manifest.yaml"), "utf8");
	const scopes = (text: string) => [...text.matchAll(/^\s+- ([a-z_:.]+)$/gm)].map((match) => match[1]!).filter((value) => value.includes(":") || value.includes("."));

	it("has the scopes of the shared manifest and the two this role needs to find a reporter", () => {
		const own = scopes(manifest.slice(manifest.indexOf("scopes:"), manifest.indexOf("settings:")));
		assert.deepEqual(own.sort(), ["app_mentions:read", "chat:write", "im:history", "im:read", "im:write", "users:read", "users:read.email"]);
		assert.equal(manifest.includes("socket_mode_enabled: true"), true);
		assert.match(manifest, /- message\.im/);
	});

	it("leaves the shared manifest, and so every other role, as it was", () => {
		assert.doesNotMatch(shared, /users:read/);
	});
});
