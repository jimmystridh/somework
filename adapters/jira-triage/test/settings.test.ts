import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadSettings, readJiraSecrets, roleEnvironment } from "../src/settings.ts";

const base = { JIRA_URL: "https://jira.example.test/", JIRA_TOKEN_FILE: "/run/secrets/jira-token" };
const yes = () => true;

describe("settings", () => {
	it("have the defaults the owner settled on", () => {
		const s = loadSettings(base, yes);
		assert.equal(s.jira.url, "https://jira.example.test");
		assert.deepEqual(s.projects, ["SAD"]);
		assert.equal(s.markerLabel, "triaged-by-bot");
		assert.equal(s.needsInfoLabel, "needs-info");
		assert.equal(s.botCreatedLabel, "created-by-bot");
		assert.equal(s.language, "en");
		assert.equal(s.enrichment, true);
		assert.equal(s.developerAgent, "agent/pi-agent");
		assert.equal(s.developerWaitMs, 10 * 60_000);
		assert.equal(s.reporterWaitMs, 48 * 3_600_000);
		assert.equal(s.reporterPollMs, 5 * 60_000);
		assert.equal(s.maxRounds, 2);
		assert.deepEqual(s.retrySchedule, [2, 5, 15, 30, 60, 120, 240, 480].map((minutes) => minutes * 60_000));
		assert.equal(s.maxAttempts, 12);
		assert.equal(s.dryRun, false);
		assert.deepEqual(s.createTypes, ["Bug", "Story", "Task", "Improvement"]);
		assert.equal(s.dailyCap, 200);
		assert.equal(s.tickMs, 15_000);
		assert.equal(s.botUser, undefined);
		assert.equal(s.developerPollMs, 20_000);
		assert.equal(s.notifyTo, "agent/manager");
		assert.deepEqual(s.slackMembers, []);
	});

	it("take the projects as a list, in any case, and refuse what is not a project key", () => {
		assert.deepEqual(loadSettings({ ...base, JIRA_PROJECTS: "sad, abc;XYZ" }, yes).projects, ["SAD", "ABC", "XYZ"]);
		assert.throws(() => loadSettings({ ...base, JIRA_PROJECTS: "SAD,1BAD" }, yes), /not a project key/);
		assert.throws(() => loadSettings({ ...base, JIRA_PROJECTS: "SAD OR project = X" }, yes), /not a project key/);
		assert.throws(() => loadSettings({ ...base, JIRA_PROJECTS: " , " }, yes), /at least one project key/);
	});

	it("need the ticket system, over https, with a token file that exists, and the certificate with its password", () => {
		assert.throws(() => loadSettings({}, yes), /JIRA_URL is required/);
		assert.throws(() => loadSettings({ JIRA_URL: "http://jira.example.test", JIRA_TOKEN_FILE: "/t" }, yes), /https/);
		assert.throws(() => loadSettings({ JIRA_URL: "https://jira.example.test" }, yes), /JIRA_TOKEN_FILE/);
		assert.throws(() => loadSettings({ ...base, JIRA_PFX_FILE: "/p.pfx" }, yes), /JIRA_PFX_PASSWORD_FILE/);
		assert.throws(() => loadSettings(base, (path) => path !== "/run/secrets/jira-token"), /JIRA_TOKEN_FILE does not exist/);
		const full = loadSettings({ ...base, JIRA_PFX_FILE: "/p.pfx", JIRA_PFX_PASSWORD_FILE: "/p.pw", JIRA_CA_FILE: "/ca.pem" }, yes);
		assert.deepEqual(full.jira, { url: "https://jira.example.test", tokenFile: "/run/secrets/jira-token", pfxFile: "/p.pfx", pfxPasswordFile: "/p.pw", caFile: "/ca.pem" });
	});

	it("reject nonsense at startup, not at the first ticket", () => {
		for (const [name, value, message] of [
			["TRIAGE_LANGUAGE", "de", /TRIAGE_LANGUAGE/],
			["TRIAGE_MAX_ROUNDS", "0", /TRIAGE_MAX_ROUNDS/],
			["TRIAGE_MAX_ROUNDS", "9", /at most 5/],
			["TRIAGE_REPORTER_WAIT_HOURS", "x", /TRIAGE_REPORTER_WAIT_HOURS/],
			["TRIAGE_RETRY_MINUTES", "5,0", /TRIAGE_RETRY_MINUTES/],
			["TRIAGE_RETRY_MINUTES", "5,5000", /TRIAGE_RETRY_MINUTES/],
			["TRIAGE_DEVELOPER_AGENT", "pi-agent", /agent id/],
			["JIRA_TRIAGE_LABEL", "has space", /Jira label/],
			["JIRA_NEEDS_INFO_LABEL", "triaged-by-bot", /must differ/],
			["TRIAGE_CREATE_TYPES", " ", /at least one issue type/],
			["TRIAGE_DAILY_CAP", "-1", /TRIAGE_DAILY_CAP/],
			["TRIAGE_TICK_SECONDS", "0", /TRIAGE_TICK_SECONDS/],
			["JIRA_BOT_USER", "x; y", /JIRA_BOT_USER/],
			["TRIAGE_DEVELOPER_POLL_SECONDS", "x", /TRIAGE_DEVELOPER_POLL_SECONDS/],
		] as const) {
			assert.throws(() => loadSettings({ ...base, [name]: value }, yes), message, `${name}=${value}`);
		}
	});

	it("read the switches, the pauses and the Slack members from the environment", () => {
		const s = loadSettings({ ...base, TRIAGE_DRY_RUN: "1", TRIAGE_ENRICH: "0", TRIAGE_LANGUAGE: "SV", TRIAGE_RETRY_MINUTES: "1,2.5", SLACK_ALLOWED_USER_IDS: "U0123ABCD,U0456EFGH", EVENTS_NOTIFY_TO: "agent/someone", TRIAGE_DEVELOPER_WAIT_MINUTES: "3" }, yes);
		assert.equal(s.dryRun, true);
		assert.equal(s.enrichment, false);
		assert.equal(s.language, "sv");
		assert.deepEqual(s.retrySchedule, [60_000, 150_000]);
		assert.deepEqual(s.slackMembers, ["U0123ABCD", "U0456EFGH"]);
		assert.equal(s.notifyTo, "agent/someone");
		assert.equal(s.developerWaitMs, 180_000);
	});
});

describe("the secrets behind the settings", () => {
	const dir = mkdtempSync(join(tmpdir(), "jira-secrets-"));
	const file = (name: string, content: string | Buffer) => {
		const path = join(dir, name);
		writeFileSync(path, content);
		return path;
	};

	it("are read once: the token trimmed, the certificate as bytes, the password without its line break, the CA as text", () => {
		const secrets = readJiraSecrets({ url: "https://j", tokenFile: file("t", "pat-0123456789\n"), pfxFile: file("p.pfx", Buffer.from([1, 2, 3])), pfxPasswordFile: file("pw", "pass word\r\n"), caFile: file("ca", "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n") });
		assert.equal(secrets.token, "pat-0123456789");
		assert.deepEqual([...secrets.pfx!], [1, 2, 3]);
		assert.equal(secrets.passphrase, "pass word");
		assert.match(secrets.ca!, /^-----BEGIN CERTIFICATE-----/);
	});

	it("treat an empty file (a /dev/null mount) as no file, but a certificate's empty password as the password", () => {
		const secrets = readJiraSecrets({ url: "https://j", tokenFile: file("t2", "tok-0123456789"), pfxFile: file("p2.pfx", Buffer.from([9])), pfxPasswordFile: file("pw2", ""), caFile: file("ca2", "") });
		assert.equal(secrets.ca, undefined);
		assert.equal(secrets.passphrase, "");
		assert.deepEqual(readJiraSecrets({ url: "https://j", tokenFile: file("t3", "tok-0123456789"), pfxFile: file("p3.pfx", Buffer.alloc(0)), pfxPasswordFile: file("pw3", "x") }).pfx, undefined);
	});

	it("refuse an empty token file", () => {
		assert.throws(() => readJiraSecrets({ url: "https://j", tokenFile: file("t4", "\n") }), /JIRA_TOKEN_FILE is empty/);
	});

	it("never show up in an error that names the file", () => {
		assert.throws(() => readJiraSecrets({ url: "https://j", tokenFile: join(dir, "missing") }), (error: Error) => !error.message.includes("pat-"));
	});
});

describe("the environment of the kit", () => {
	it("turns events on without overriding what the deployment says", () => {
		assert.equal(roleEnvironment({}).EVENTS_ENABLED, "1");
		assert.equal(roleEnvironment({ EVENTS_ENABLED: "0" }).EVENTS_ENABLED, "0");
		assert.equal(roleEnvironment({ A: "b" }).A, "b");
	});
});

describe("the label check and the quiet time", () => {
	it("default to the labels mode, ten quiet minutes (an hour at most) and the four areas", () => {
		const s = loadSettings(base, yes);
		assert.equal(s.mode, "labels");
		assert.equal(s.quietMs, 10 * 60_000);
		assert.equal(s.quietMaxMs, 60 * 60_000);
		assert.deepEqual(s.areaLabels, ["Backend", "Frontend", "Infrastructure", "Security"]);
	});

	it("follow the deployment, allow no quiet time, and never let the longest wait be shorter than the quiet time", () => {
		const s = loadSettings({ ...base, TRIAGE_MODE: "checklist", TRIAGE_QUIET_MINUTES: "0", TRIAGE_AREA_LABELS: "Api, Ui" }, yes);
		assert.deepEqual([s.mode, s.quietMs, s.areaLabels], ["checklist", 0, ["Api", "Ui"]]);
		assert.equal(loadSettings({ ...base, TRIAGE_QUIET_MINUTES: "90" }, yes).quietMaxMs, 90 * 60_000);
	});

	it("refuse what cannot work", () => {
		assert.throws(() => loadSettings({ ...base, TRIAGE_MODE: "both" }, yes), /TRIAGE_MODE/);
		assert.throws(() => loadSettings({ ...base, TRIAGE_QUIET_MINUTES: "-1" }, yes), /TRIAGE_QUIET_MINUTES/);
		assert.throws(() => loadSettings({ ...base, TRIAGE_AREA_LABELS: "Backend,backend" }, yes), /repeat/);
		assert.throws(() => loadSettings({ ...base, TRIAGE_AREA_LABELS: "Back!end" }, yes), /Jira label/);
		assert.throws(() => loadSettings({ ...base, TRIAGE_AREA_LABELS: "needs-info,Backend" }, yes), /bot's own labels/);
	});
});
