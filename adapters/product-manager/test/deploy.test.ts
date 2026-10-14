import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const role = new URL("..", import.meta.url).pathname;
const adapters = join(role, "..");
const read = (...path: string[]) => readFileSync(join(role, ...path), "utf8");
const compose = read("deploy", "compose.yaml");
const example = read("deploy", ".env.example");

const hostPorts = (text: string): string[] => [...text.matchAll(/ports:\s*\["[^"]*?:?(\d+):\d+"\]/g)].map((match) => match[1]!);

describe("the compose file", () => {
	it("publishes its health port on 8086, which no other stack of the host uses", () => {
		assert.deepEqual(hostPorts(compose), ["8086"]);
		for (const other of readdirSync(adapters)) {
			if (other === "product-manager") continue;
			try {
				assert.deepEqual(hostPorts(readFileSync(join(adapters, other, "deploy", "compose.yaml"), "utf8")).filter((port) => port === "8086"), [], `${other} already uses 8086`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
	});

	it("lets the sandbox reach the code host only, through the proxy", () => {
		assert.match(compose, /networks:\n  sandbox-net:\n    internal: true/);
		const sandbox = compose.slice(compose.indexOf("\n  sandbox:"), compose.indexOf("\n  # The sandbox's only way out"));
		assert.match(sandbox, /networks: \[sandbox-net\]/);
		assert.match(compose, /EGRESS_ALLOW: \$\{EGRESS_ALLOW:-github\.com,\*\.github\.com,\*\.githubusercontent\.com\}/);
		assert.match(compose, /image: somework-pi-sandbox:\$\{SANDBOX_VERSION:\?/);
	});

	it("is hardened like the other stacks", () => {
		for (const line of ["read_only: true", "cap_drop: [ALL]", 'security_opt: ["no-new-privileges:true"]', "privileged: false", "restart: unless-stopped"]) assert.ok(compose.includes(line), line);
		assert.match(compose, /user: "10001:10001"/);
		assert.match(compose, /image: somework-product-manager:\$\{PRODUCT_MANAGER_VERSION:\?/);
		assert.match(compose, /name: somework-product-manager/);
	});

	it("is read-only: no events, no push credential, no job or watch settings", () => {
		assert.doesNotMatch(compose, /EVENTS_|WATCH_|TIMERS_|OBSERVE_/);
		assert.match(compose, /GIT_TOKEN_FILE: \/run\/secrets\/git-token/);
		assert.doesNotMatch(compose, /GIT_PUSH|GITHUB_APP/);
	});

	it("takes every secret from a file, and leaves Plane, Telegram and Slack off by mounting /dev/null until they are configured", () => {
		assert.doesNotMatch(compose, /PLANE_API_KEY:|SLACK_BOT_TOKEN:|SLACK_APP_TOKEN:|TELEGRAM_BOT_TOKEN:/);
		for (const variable of ["PLANE_KEY_HOST", "PLANE_CA_HOST", "TELEGRAM_TOKEN_HOST", "SLACK_BOT_TOKEN_HOST", "SLACK_APP_TOKEN_HOST"]) assert.match(compose, new RegExp(`\\$\\{${variable}:-/dev/null\\}`), variable);
		for (const name of ["PLANE_BASE_URL", "PLANE_WORKSPACE_SLUG", "PLANE_PROJECT_ID", "PLANE_API_KEY_FILE", "PLANE_LABELS", "TELEGRAM_BOT_TOKEN_FILE", "TELEGRAM_ALLOWED_USER_IDS", "SLACK_ALLOWED_USER_IDS", "APPROVERS", "CHAT_REPOSITORY_URL"]) assert.match(compose, new RegExp(`\\n      ${name}: `), name);
		assert.match(compose, /PLANE_BASE_URL: \$\{PLANE_BASE_URL:-\}/);
	});

	it("is explained: every required variable of the compose file is in the example environment, and the example holds no secret", () => {
		for (const match of compose.matchAll(/\$\{([A-Z_]+):\?/g)) assert.match(example, new RegExp(`^${match[1]}=`, "m"), match[1]);
		assert.doesNotMatch(example, /xox[bpa]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|plane_api_[A-Za-z0-9_]{10,}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b.*(?:token|key)/i);
	});
});

describe("the image", () => {
	const dockerfile = read("Dockerfile");

	it("installs only this role's tree from the workspace's lockfile and checks at build time that everything imports", () => {
		assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts -w @somework\/product-manager/);
		for (const file of ["adapters/product-manager/src", "adapters/product-manager/card.json"]) assert.ok(dockerfile.includes(`COPY ${file} /app/${file}`), file);
		for (const module of ["./src/profile.ts", "./src/hooks.ts", "./src/guard.ts", "./src/chat.ts", "@earendil-works/pi-durable"]) assert.ok(dockerfile.includes(`'${module}'`), module);
		assert.match(dockerfile, /USER 10001:10001/);
		assert.match(dockerfile, /CMD \["node", "src\/main\.ts"\]/);
	});

	it("is one the workspace can install: the package declares what the kit's roles declare", () => {
		const own = JSON.parse(read("package.json"));
		const clusterDev = JSON.parse(readFileSync(join(adapters, "cluster-dev", "package.json"), "utf8"));
		assert.equal(own.name, "@somework/product-manager");
		assert.deepEqual(own.dependencies, clusterDev.dependencies);
		assert.deepEqual(own.scripts, clusterDev.scripts);
		assert.equal(own.type, "module");
	});
});
