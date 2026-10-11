import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { hostAllowed } from "@somework/agent-kit/egress/proxy";
import { API_BASES, OAUTH_URL } from "../src/aikido/client.ts";

const role = new URL("..", import.meta.url).pathname;
const read = (...path: string[]) => readFileSync(join(role, ...path), "utf8");
const compose = read("deploy", "compose.yaml");
const example = read("deploy", ".env.example");
const deployReadme = read("deploy", "README.md");
const section = (from: string, to: string): string => compose.slice(compose.indexOf(from), compose.indexOf(to));
const agent = section("\n  agent:", "\n  sandbox:");
const sandbox = section("\n  sandbox:", "\n  # The sandbox's way out");
const egress = section("\n  egress:", "\n  # One-shot");

const EGRESS_EXPRESSION = /EGRESS_ALLOW: \$\{EGRESS_ALLOW:-([^}]+)\}\$\{AIKIDO_EGRESS_HOSTS:\+,\$\{AIKIDO_EGRESS_HOSTS\}\}/;
const allowListFor = (aikidoHosts: string | undefined): string[] => {
	const [, defaults] = EGRESS_EXPRESSION.exec(egress)!;
	return [...defaults!.split(","), ...(aikidoHosts ? aikidoHosts.split(",") : [])];
};
const hostsOfRegion = (region: string): string[] => [...new Set([new URL(OAUTH_URL).host, new URL(API_BASES[region]!).host])];

describe("the aikido command in the sandbox: compose", () => {
	it("is off by default: the binary, the wrapper and the client file are all /dev/null mounts, and the model is not told it exists", () => {
		for (const [variable, target] of [["AIKIDO_CLI_HOST", "/opt/aikido/aikido"], ["AIKIDO_CLI_WRAPPER_HOST", "/usr/local/bin/aikido"], ["AIKIDO_SANDBOX_CLIENT_HOST", "/run/secrets/aikido-client.json"]] as const) {
			assert.ok(sandbox.includes(`- \${${variable}:-/dev/null}:${target}:ro`), `${variable} is mounted read-only at ${target}`);
		}
		assert.match(agent, /AIKIDO_SANDBOX_CLI: \$\{AIKIDO_SANDBOX_CLI:-0\}/);
	});

	it("puts the credentials in a file of the sandbox's own, never the harness's client file, and never in an environment variable", () => {
		assert.ok(!sandbox.includes("./secrets/aikido-client.json"), "the harness's client stays out of the sandbox");
		assert.ok(agent.includes("./secrets/aikido-client.json:/run/secrets/aikido-client.json:ro"), "the harness keeps reading its own");
		const environment = sandbox.slice(sandbox.indexOf("environment:"), sandbox.indexOf("volumes:"));
		assert.doesNotMatch(environment, /AIKIDO|SECRET|TOKEN_FILE: \/run\/secrets\/aikido/);
		assert.doesNotMatch(compose, /AIKIDO_CLIENT_SECRET|AIKIDO_CLIENT_ID|AIKIDO_TOKEN_FILE/);
	});

	it("gives the sandbox no way out except the egress proxy: an internal network, the proxy's address for its commands, no published port", () => {
		assert.match(compose, /networks:\n  sandbox-net:\n    internal: true/);
		assert.match(sandbox, /networks: \[sandbox-net\]/);
		assert.doesNotMatch(sandbox, /\boutside\b|ports:|network_mode/);
		assert.match(sandbox, /HTTPS_PROXY: http:\/\/egress:8888/);
		assert.match(egress, /networks: \[sandbox-net, outside\]/);
	});

	it("keeps the sandbox as hardened as before", () => {
		assert.match(sandbox, /<<: \*hardened/);
		assert.match(sandbox, /user: "10002:10002"/);
		assert.match(sandbox, /group_add: \["10010"\]/);
	});

	it("is documented in the example environment with every variable the compose file reads for it", () => {
		for (const name of ["AIKIDO_SANDBOX_CLI", "AIKIDO_CLI_HOST", "AIKIDO_CLI_WRAPPER_HOST", "AIKIDO_SANDBOX_CLIENT_HOST", "AIKIDO_EGRESS_HOSTS"]) assert.match(example, new RegExp(`^# ${name}=`, "m"), name);
		assert.doesNotMatch(example, /clientSecret": "[^."]{6,}/);
	});
});

describe("the aikido command in the sandbox: egress allow-list", () => {
	it("is unchanged until AIKIDO_EGRESS_HOSTS is set: Aikido is not reachable from the sandbox by default", () => {
		for (const host of ["app.aikido.dev", "app.us.aikido.dev", "app.me.aikido.dev"]) assert.equal(hostAllowed(host, allowListFor(undefined)), false, host);
		assert.equal(hostAllowed("github.com", allowListFor(undefined)), true);
	});

	it("admits exactly the hosts of the region's API and token endpoint, as the client names them, and nothing broader", () => {
		for (const region of Object.keys(API_BASES)) {
			const list = allowListFor(hostsOfRegion(region).join(","));
			for (const host of hostsOfRegion(region)) assert.equal(hostAllowed(host, list), true, `${region}: ${host}`);
			for (const host of ["aikido.dev", "evil.aikido.dev", "app.aikido.dev.evil.example", "api.aikido.dev", "evilapp.aikido.dev"]) assert.equal(hostAllowed(host, list), false, `${region}: ${host}`);
			assert.ok(!allowListFor(hostsOfRegion(region).join(",")).some((pattern) => pattern.includes("*") && pattern.includes("aikido")), "no wildcard for Aikido");
		}
		assert.equal(hostAllowed("app.us.aikido.dev", allowListFor(hostsOfRegion("eu").join(","))), false, "region eu does not open the us host");
	});

	it("keeps the rest of the list as it was and adds to a deployment's own EGRESS_ALLOW instead of replacing it", () => {
		assert.match(egress, EGRESS_EXPRESSION);
		for (const host of ["github.com", "registry.npmjs.org", "api.nuget.org", "pypi.org"]) assert.equal(hostAllowed(host, allowListFor("app.aikido.dev")), true, host);
		assert.equal(hostAllowed("example.com", allowListFor("app.aikido.dev")), false);
		assert.doesNotMatch(EGRESS_EXPRESSION.exec(egress)![1]!, /aikido/);
	});

	it("is spelled out in the runbook for each region, in the form the compose file takes", () => {
		for (const region of Object.keys(API_BASES)) assert.ok(deployReadme.includes(`AIKIDO_EGRESS_HOSTS=${hostsOfRegion(region).join(",")}`), region);
	});
});

describe("the wrapper file", () => {
	it("is executable in the repository, so a copy keeps the mode a bind mount needs", () => {
		assert.ok(statSync(join(role, "sandbox", "aikido-wrapper.cjs")).mode & 0o111);
	});

	it("is not baked into any image: the Dockerfile of this role does not copy it and builds nothing new", () => {
		assert.doesNotMatch(read("Dockerfile"), /aikido-wrapper|COPY adapters\/aikido-fixer\/sandbox/);
	});
});
