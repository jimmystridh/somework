import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { credentialLiteralReason } from "../src/classifier/index.ts";

const root = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const repository = join(root, "../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

/** Every file the role ships, except what the tests carry on purpose (fake tokens) and what npm installs. */
function shipped(dir = root): string[] {
	return readdirSync(dir).flatMap((name) => {
		if (name === "node_modules" || name === "test") return [];
		const path = join(dir, name);
		return statSync(path).isDirectory() ? shipped(path) : [path];
	});
}

describe("the deployment files", () => {
	const compose = read("deploy/compose.yaml");
	const example = read("deploy/.env.example");

	it("hold no secret, no private key and no address anywhere in what the role ships", () => {
		const files = shipped();
		assert.ok(files.length > 25, `${files.length} files`);
		for (const file of files) {
			const text = readFileSync(file, "utf8");
			const name = relative(root, file);
			assert.equal(credentialLiteralReason(text.replace(/https?:\/\/(?:USER|ORG|user|org)[^\s)]*/g, "")), undefined, `${name} carries a credential: ${credentialLiteralReason(text)}`);
			assert.doesNotMatch(text, /BEGIN [A-Z ]*PRIVATE KEY/, `${name} holds a private key`);
			assert.doesNotMatch(text, /\b(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/, `${name} holds a private address`);
		}
	});

	it("give every secret as a mounted file that is empty when it is not set, and never as an environment value", () => {
		for (const line of compose.split("\n")) {
			if (/^\s*#/.test(line)) continue;
			assert.doesNotMatch(line, /^\s+[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)(?!_FILE|_HOST|_HOSTS|_EXPIRES|_CAP|_SHARE|S\b|_PER|_MINUTES|_MODE):\s*\S/, `a secret as a value: ${line.trim()}`);
		}
		for (const mount of ["/run/secrets/ci-token", "/run/secrets/grafana-token", "/run/secrets/telegram-bot-token"]) assert.match(compose, new RegExp(`:-/dev/null\\}:${mount.replace(/\//g, "\\/")}:ro`), `${mount} falls back to /dev/null`);
		for (const mount of ["/run/secrets/sandbox-token", "/run/secrets/git-token", "/run/secrets/ssh"]) assert.ok(compose.includes(`:${mount}:ro`), `${mount} is mounted read only`);
		assert.match(compose, /\.\/secrets\/pi:\/run\/secrets\/pi\s/);
	});

	it("run one thing at a time, as the service requires, with every container hardened", () => {
		assert.match(compose, /PI_CONCURRENCY: "1"/);
		assert.match(compose, /^name: somework-cluster-dev$/m);
		assert.ok(!/privileged: true|network_mode: host|docker\.sock/.test(compose), "no privilege, no host network, no docker socket");
		assert.match(compose, /x-hardened: &hardened\n\s+read_only: true\n\s+cap_drop: \[ALL\]\n\s+security_opt: \["no-new-privileges:true"\]\n\s+privileged: false/);
		assert.equal((compose.match(/<<: \*hardened/g) ?? []).length, 3, "agent, sandbox and egress");
		assert.match(compose, /image: somework-pi-sandbox:/);
		assert.match(compose, /image: somework-pi-egress:/);
	});

	it("keep the sandbox on the internal network, with the egress proxy as its only way out", () => {
		const sandbox = /\n  sandbox:\n([\s\S]*?)\n  egress:/.exec(compose)![1]!;
		assert.match(sandbox, /networks: \[sandbox-net\]/);
		assert.doesNotMatch(sandbox, /outside/);
		assert.match(compose, /sandbox-net:\n\s+internal: true/);
		assert.doesNotMatch(sandbox, /\/run\/secrets\/(?!sandbox-token)/, "the sandbox sees no secret but the daemon's own token");
	});

	it("push to the organisation remote, never origin, and let only people approve", () => {
		assert.match(compose, /CLUSTER_DEV_GIT_REMOTE: \$\{CLUSTER_DEV_GIT_REMOTE:-org\}/);
		assert.doesNotMatch(example, /^CLUSTER_DEV_GIT_REMOTE=origin/m);
		assert.match(compose, /APPROVERS: \$\{APPROVERS:-\}[^\n]*Never add agent\/manager/);
		assert.match(compose, /OBSERVE_SCOPE: \$\{OBSERVE_SCOPE:-fleet\}/);
	});

	it("name every variable the role reads, and the example sets every variable the compose file requires", () => {
		const settings = readFileSync(join(root, "src/settings.ts"), "utf8");
		const read_ = [...new Set([...settings.matchAll(/env\.((?:CLUSTER_DEV|CI)_[A-Z_]+)/g)].map((match) => match[1]!))];
		assert.ok(read_.length >= 15, read_.join(", "));
		const readme = read("README.md");
		const decision = readFileSync(join(repository, "docs/CLUSTER_DEV_AGENT.md"), "utf8");
		for (const name of read_) {
			assert.ok(readme.includes(name), `README.md documents ${name}`);
			assert.ok(decision.includes(name), `docs/CLUSTER_DEV_AGENT.md lists ${name}`);
			if (!["CLUSTER_DEV_SSH_KNOWN_HOSTS", "CLUSTER_DEV_WORKSPACES", "CI_CA_FILE", "CLUSTER_DEV_AGENTS_CA_FILE"].includes(name)) assert.ok(compose.includes(name), `compose.yaml passes ${name}`);
		}
		for (const required of [...compose.matchAll(/\$\{([A-Z_]+):\?/g)].map((match) => match[1]!)) assert.match(example, new RegExp(`^${required}=`, "m"), `.env.example sets ${required}`);
	});

	it("tell the host list, the key file and the known hosts the way the service reads them", () => {
		assert.match(example, /^CLUSTER_DEV_HOSTS=agents=USER@\S+,services=\S+,runner=\S+,pve-host=root@\S+$/m);
		assert.match(compose, /\.\/secrets\/ssh:\/run\/secrets\/ssh:ro/);
		assert.match(compose, /CLUSTER_DEV_SSH_KEY_DIR: \/run\/secrets\/ssh/);
	});
});

describe("the image", () => {
	const dockerfile = read("Dockerfile");
	it("builds the harness only, with an ssh client, as an ordinary user, and checks at build time that everything imports", () => {
		assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts -w @somework\/cluster-dev/);
		assert.match(dockerfile, /apt-get install -y --no-install-recommends openssh-client/);
		assert.match(dockerfile, /USER 10001:10001/);
		assert.match(dockerfile, /FROM app AS agent/);
		assert.doesNotMatch(dockerfile, /AS sandbox|AS egress/);
		for (const module of ["./src/profile.ts", "./src/hooks.ts", "./src/classifier/index.ts", "@somework/agent-kit"]) assert.ok(dockerfile.includes(module), module);
		assert.match(dockerfile, /CMD \["node", "src\/main\.ts"\]/);
	});

	it("is registered as a workspace in the lockfile, with the same dependencies as the package", () => {
		const lock = JSON.parse(readFileSync(join(repository, "package-lock.json"), "utf8"));
		const manifest = JSON.parse(read("package.json"));
		assert.equal(lock.packages["adapters/cluster-dev"].name, "@somework/cluster-dev");
		assert.deepEqual(lock.packages["adapters/cluster-dev"].dependencies, manifest.dependencies);
		assert.deepEqual(lock.packages["node_modules/@somework/cluster-dev"], { resolved: "adapters/cluster-dev", link: true });
	});
});

describe("the firewall allow file", () => {
	const lines = read("deploy/firewall-allow.example.txt").split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
	it("lists the destinations the agent needs, one per line, as names or placeholders", () => {
		assert.ok(lines.length >= 15);
		for (const line of lines) assert.match(line, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, line);
		for (const name of ["api.openai.com", "github.com", "api.github.com", "api.telegram.org", "AGENTS_VM_ADDRESS", "HYPERVISOR_ADDRESS"]) assert.ok(lines.includes(name), name);
		assert.equal(new Set(lines).size, lines.length, "no destination twice");
	});
});
