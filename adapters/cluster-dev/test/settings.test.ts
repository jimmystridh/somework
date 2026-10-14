import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bashApproval, fileApproval } from "../src/approvals.ts";
import { classifyContext, loadSettings, parseAgentUrls, parseHosts, roleEnvironment } from "../src/settings.ts";

const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

describe("the extra repositories", () => {
	it("are none by default, and are read with a token file each", () => {
		assert.deepEqual(loadSettings(env({})).extraRepositories, []);
		const settings = loadSettings(env({ CLUSTER_DEV_EXTRA_REPOSITORIES: "somework=https://github.com/acme/somework/, tools = https://github.com/acme/tools".replace(" = ", "="), CLUSTER_DEV_GIT_TOKEN_DIR: "/run/secrets/git/" }));
		assert.deepEqual(settings.extraRepositories, [
			{ name: "somework", url: "https://github.com/acme/somework", tokenFile: "/run/secrets/git/git-token-somework" },
			{ name: "tools", url: "https://github.com/acme/tools", tokenFile: "/run/secrets/git/git-token-tools" },
		]);
		assert.deepEqual(classifyContext(settings).extraRemotes, ["somework", "tools"]);
	});

	it("refuse origin, the organisation remote's name, a name used twice, a password, and anything but https", () => {
		for (const bad of ["origin=https://github.com/a/b", "org=https://github.com/a/b", "x=https://github.com/a/b,x=https://github.com/a/c", "x=https://user:pw@github.com/a/b", "x=http://github.com/a/b", "x=git@github.com:a/b.git", "https://github.com/a/b", "=https://github.com/a/b"]) {
			assert.throws(() => loadSettings(env({ CLUSTER_DEV_EXTRA_REPOSITORIES: bad })), /CLUSTER_DEV_EXTRA_REPOSITORIES/, bad);
		}
	});
});

describe("the settings", () => {
	it("have safe defaults and need nothing to load", () => {
		const settings = loadSettings(env({}));
		assert.equal(settings.gitRemote, "org");
		assert.deepEqual(settings.hosts, []);
		assert.deepEqual(settings.hypervisorHosts, ["pve-host", "proxmox", "pve"]);
		assert.equal(settings.sshKeyDir, "/run/secrets/ssh");
		assert.equal(settings.sshKnownHosts, "/run/secrets/ssh/known_hosts");
		assert.equal(settings.execTimeoutSeconds, 120);
		assert.equal(settings.execMaxBytes, 32_768);
		assert.deepEqual(settings.workspaces, ["/workspace", "/tmp"]);
		assert.equal(settings.ci, undefined);
		assert.deepEqual(settings.agentUrls, {});
	});

	it("parse the hosts, the agents' health addresses and the CI", () => {
		const settings = loadSettings(
			env({
				CLUSTER_DEV_REPOSITORY: "https://github.com/acme/somework",
				CLUSTER_DEV_GIT_REMOTE: "company",
				CLUSTER_DEV_HOSTS: "agents=js@10.10.10.20, services=ops@10.10.10.11:2222 pve-host=root@10.10.10.1",
				CLUSTER_DEV_AGENT_URLS: "reviewer=http://10.10.10.20:8082,developer=http://10.10.10.20:8081/",
				CLUSTER_DEV_OWN_SERVICES: "somework-*",
				CLUSTER_DEV_SCRIPTS: "scripts/roll.sh",
				CI_URL: "https://ci.internal:8443/",
				CI_REPO: "acme/somework",
				CI_TOKEN_FILE: "/run/secrets/ci-token",
				CI_CA_FILE: "/run/somework/ca.pem",
			}),
		);
		assert.equal(settings.repositoryUrl, "https://github.com/acme/somework");
		assert.equal(settings.gitRemote, "company");
		assert.deepEqual(settings.hosts, [
			{ name: "agents", user: "js", address: "10.10.10.20", port: 22 },
			{ name: "services", user: "ops", address: "10.10.10.11", port: 2222 },
			{ name: "pve-host", user: "root", address: "10.10.10.1", port: 22 },
		]);
		assert.deepEqual(settings.agentUrls, { reviewer: "http://10.10.10.20:8082", developer: "http://10.10.10.20:8081" });
		assert.deepEqual(settings.ownServices, ["somework-*"]);
		assert.deepEqual(settings.scripts, ["scripts/roll.sh"]);
		assert.deepEqual(settings.ci, { url: "https://ci.internal:8443", repository: "acme/somework", tokenFile: "/run/secrets/ci-token", caFile: "/run/somework/ca.pem" });
	});

	it("refuse origin as the push remote, an address with a password and everything malformed, at startup", () => {
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_GIT_REMOTE: "origin" })), /origin/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_GIT_REMOTE: "bad name" })), /remote name/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_REPOSITORY: "git@github.com:a/b.git" })), /https/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_HOSTS: "agents" })), /name=user@address/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_HOSTS: "Agents=js@x" })), /host name/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_HOSTS: "a=js@x,a=js@y" })), /twice/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_HOSTS: "a=js@-oProxyCommand=x" })), /address/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_HOSTS: "a=js@x:99999" })), /port/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_HOSTS: "a=Bad User@x" })), /user name|name=user@address/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_AGENT_URLS: "r=ftp://x" })), /http or https/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_AGENT_URLS: "r=http://u:p@x:1" })), /password/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_AGENT_URLS: "r" })), /name=http/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_EXEC_TIMEOUT_SECONDS: "5000" })), /at most 900/);
		assert.throws(() => loadSettings(env({ CLUSTER_DEV_EXEC_MAX_BYTES: "0" })), /positive integer/);
		assert.throws(() => loadSettings(env({ CI_URL: "https://ci", CI_REPO: "x", CI_TOKEN_FILE: "/t" })), /owner\/name/);
		assert.throws(() => loadSettings(env({ CI_URL: "https://ci", CI_REPO: "a/b" })), /CI_TOKEN_FILE/);
		assert.throws(() => loadSettings(env({ CI_URL: "ftp://ci", CI_REPO: "a/b", CI_TOKEN_FILE: "/t" })), /http/);
		assert.deepEqual(parseHosts(""), []);
		assert.deepEqual(parseAgentUrls(undefined), {});
	});

	it("give the classifier the sandbox's workspace for the agent's own commands and the host for a machine of the cluster", () => {
		const settings = loadSettings(env({ CLUSTER_DEV_GIT_REMOTE: "company", CLUSTER_DEV_OWN_SERVICES: "somework-*" }));
		const local = classifyContext(settings);
		assert.deepEqual(local.workspaces, ["/workspace", "/tmp"]);
		assert.equal(local.host, undefined);
		assert.equal(local.remote, "company");
		const remote = classifyContext(settings, "agents");
		assert.equal(remote.host, "agents");
		assert.equal(remote.workspaces, undefined, "nothing on a machine is the agent's workspace");
		assert.deepEqual(remote.ownServices, ["somework-*"]);
	});

	it("fill in what the kit needs without overriding the deployment", () => {
		const filled = roleEnvironment(env({ CLUSTER_DEV_REPOSITORY: "https://github.com/acme/somework" }));
		assert.equal(filled.PI_CONCURRENCY, "1");
		assert.equal(filled.CHAT_REPOSITORY_URL, "https://github.com/acme/somework");
		assert.equal(filled.OBSERVE_SCOPE, "fleet");
		assert.match(filled.GIT_AUTHOR_EMAIL!, /cluster-dev@/);
		const kept = roleEnvironment(env({ PI_CONCURRENCY: "2", OBSERVE_SCOPE: "own", CHAT_REPOSITORY_URL: "https://x/y", GIT_AUTHOR_NAME: "Me", CLUSTER_DEV_REPOSITORY: "https://github.com/acme/somework" }));
		assert.deepEqual([kept.PI_CONCURRENCY, kept.OBSERVE_SCOPE, kept.CHAT_REPOSITORY_URL, kept.GIT_AUTHOR_NAME], ["2", "own", "https://x/y", "Me"]);
	});
});

describe("asking in the sandbox", () => {
	it("is off by default, and on with CLUSTER_DEV_ASK_IN_SANDBOX=1", () => {
		assert.equal(loadSettings(env({})).askInSandbox, false);
		assert.equal(classifyContext(loadSettings(env({}))).sandbox, "free");
		assert.equal(loadSettings(env({ CLUSTER_DEV_ASK_IN_SANDBOX: "1" })).askInSandbox, true);
		assert.equal(classifyContext(loadSettings(env({ CLUSTER_DEV_ASK_IN_SANDBOX: "1" }))).sandbox, undefined);
		assert.equal(classifyContext(loadSettings(env({})), "agents").sandbox, "free", "a machine is judged as a machine whatever the flag says");
	});

	it("decides what the owner is asked: nothing in the sandbox by default, the old questions with the flag", () => {
		const free = loadSettings(env({}));
		const strict = loadSettings(env({ CLUSTER_DEV_CONFIRM: "1", CLUSTER_DEV_ASK_IN_SANDBOX: "1" }));
		assert.equal(bashApproval({ command: "rm -rf /srv/old" }, free), undefined);
		assert.equal(fileApproval("read", { path: "/home/js/.ssh/id_rsa" }, free), undefined);
		assert.match(bashApproval({ command: "rm -rf /srv/old" }, strict)!, /^bash: rm -rf \/srv\/old \[data:/);
		assert.match(fileApproval("read", { path: "/home/js/.ssh/id_rsa" }, strict)!, /\[secrets: the ssh directory\]/);
	});
});

describe("confirmations", () => {
	it("are off by default and come back with CLUSTER_DEV_CONFIRM=1", () => {
		assert.equal(loadSettings(env({})).confirm, false);
		assert.equal(loadSettings(env({ CLUSTER_DEV_CONFIRM: "1" })).confirm, true);
		assert.equal(loadSettings(env({ CLUSTER_DEV_CONFIRM: "0" })).confirm, false);
	});

	it("ask nothing without the flag, not even for what the flag would ask about", () => {
		const off = loadSettings(env({ CLUSTER_DEV_ASK_IN_SANDBOX: "1" }));
		assert.equal(bashApproval({ command: "rm -rf /srv/old" }, off), undefined);
		assert.equal(fileApproval("read", { path: "/home/js/.ssh/id_rsa" }, off), undefined);
	});
});
