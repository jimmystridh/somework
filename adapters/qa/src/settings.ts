import { existsSync, readFileSync } from "node:fs";
import { loadWindowsEnvSettings, type WindowsEnvSettings } from "@somework/agent-kit/windows";

export const DEFAULT_TICKET_PATTERN = "^[A-Z][A-Z0-9]+-[0-9]+$";

export interface JiraSettings {
	url: string;
	/** The client certificate (PKCS#12) the host demands, its password and the personal access token. Files, never values in the environment. */
	pfxFile?: string;
	pfxPasswordFile?: string;
	tokenFile: string;
	/** A private CA that signed the host's certificate, when the platform trust store does not know it. */
	caFile?: string;
	/** The status a ticket under verification is expected to be in, and the one a not-fixed ticket goes back to. */
	testStatus: string;
	inProgressStatus: string;
	/** The label that marks a ticket as verified; only ever added for a `verified` result. */
	verifiedLabel: string;
	/** `no-qa`: a ticket that carries it is never verified. `qa-verify`: adding it to a ticket starts a verification, and it is taken away again afterwards. */
	skipLabel: string;
	requestLabel: string;
	/** The writes that wait for the requester's approval (tool names). Absent: all of them. The hand-back that moves a ticket should always stay on the list. */
	approve?: string[];
}

export interface QaSettings extends WindowsEnvSettings {
	/** Which ticket keys this agent handles; anything else is `skipped` without a call to the ticket system. */
	ticketPattern: RegExp;
	profilesFile?: string;
	browser: { channel: string; allowHosts: string[] };
	jira?: JiraSettings;
}

const LABEL = /^[A-Za-z0-9_.-]{1,50}$/;

/** The two labels people use to steer the QA agent from Jira; the shipped handler and the service read the same names. */
export function loadQaLabels(env: Record<string, string | undefined>): { skipLabel: string; requestLabel: string } {
	const skipLabel = (env.JIRA_QA_SKIP_LABEL || "no-qa").trim();
	const requestLabel = (env.JIRA_QA_REQUEST_LABEL || "qa-verify").trim();
	for (const [name, value] of [["JIRA_QA_SKIP_LABEL", skipLabel], ["JIRA_QA_REQUEST_LABEL", requestLabel]] as const) if (!LABEL.test(value)) throw new Error(`${name} must be a Jira label: letters, digits, dot, dash and underscore, no spaces`);
	if (skipLabel.toLowerCase() === requestLabel.toLowerCase()) throw new Error("JIRA_QA_SKIP_LABEL and JIRA_QA_REQUEST_LABEL must differ");
	if (skipLabel.toLowerCase() === (env.JIRA_VERIFIED_LABEL || "AgentTested").toLowerCase() || requestLabel.toLowerCase() === (env.JIRA_VERIFIED_LABEL || "AgentTested").toLowerCase()) throw new Error("the QA skip and request labels must differ from JIRA_VERIFIED_LABEL");
	return { skipLabel, requestLabel };
}

const list = (value: string | undefined): string[] => (value ?? "").split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);

/**
 * QA's own settings next to the Windows environment's (`WINDOWS_*`, read by the kit) and the kit's (`SOMEWORK_*`, `PI_*`, `SKILLS_*`).
 *   QA_TICKET_PATTERN        regular expression of the ticket keys this agent handles (default any `ABC-123`); the deployment narrows it
 *   QA_PROFILES_FILE         JSON with the application profiles (how to start the application and what tells that it is up)
 *   QA_BROWSER_CHANNEL       the installed browser Playwright drives (default `msedge`)
 *   QA_BROWSER_ALLOW_HOSTS   hosts the browser may reach, comma separated (default `127.0.0.1,localhost`)
 *   JIRA_URL, JIRA_TOKEN_FILE, JIRA_PFX_FILE, JIRA_PFX_PASSWORD_FILE, JIRA_CA_FILE   the ticket system; without JIRA_URL there is none
 *   JIRA_TEST_STATUS, JIRA_IN_PROGRESS_STATUS, JIRA_VERIFIED_LABEL                      names in that system (defaults Test, In Progress, AgentTested)
 *   JIRA_QA_SKIP_LABEL, JIRA_QA_REQUEST_LABEL                                            labels people set to steer the agent (defaults no-qa, qa-verify)
 *   QA_JIRA_APPROVE                                                                      the write tools that wait for the requester (default all; a comma list narrows it)
 * Exactly one job runs at a time (`PI_CONCURRENCY=1`): the application under test, the browser and the ticket state are per machine.
 */
export function loadQaSettings(env: Record<string, string | undefined>, exists: (path: string) => boolean = existsSync): QaSettings {
	if (Number(env.PI_CONCURRENCY ?? "1") !== 1) throw new Error("the QA agent runs one job at a time: PI_CONCURRENCY must be 1");
	let ticketPattern: RegExp;
	try {
		ticketPattern = new RegExp(env.QA_TICKET_PATTERN || DEFAULT_TICKET_PATTERN);
	} catch (error) {
		throw new Error(`QA_TICKET_PATTERN is not a regular expression: ${error instanceof Error ? error.message : String(error)}`);
	}
	const allowHosts = list(env.QA_BROWSER_ALLOW_HOSTS);
	let jira: JiraSettings | undefined;
	if (env.JIRA_URL) {
		if (!/^https:\/\//.test(env.JIRA_URL)) throw new Error("JIRA_URL must be an https URL");
		if (!env.JIRA_TOKEN_FILE) throw new Error("JIRA_URL needs JIRA_TOKEN_FILE");
		for (const [name, file] of [["JIRA_TOKEN_FILE", env.JIRA_TOKEN_FILE], ["JIRA_PFX_FILE", env.JIRA_PFX_FILE], ["JIRA_PFX_PASSWORD_FILE", env.JIRA_PFX_PASSWORD_FILE], ["JIRA_CA_FILE", env.JIRA_CA_FILE]] as const) {
			if (file && !exists(file)) throw new Error(`${name} does not exist: ${file}`);
		}
		if (Boolean(env.JIRA_PFX_FILE) !== Boolean(env.JIRA_PFX_PASSWORD_FILE) && env.JIRA_PFX_FILE) throw new Error("JIRA_PFX_FILE needs JIRA_PFX_PASSWORD_FILE (an empty file for a certificate without a password)");
		jira = {
			url: env.JIRA_URL.replace(/\/+$/, ""),
			tokenFile: env.JIRA_TOKEN_FILE,
			pfxFile: env.JIRA_PFX_FILE || undefined,
			pfxPasswordFile: env.JIRA_PFX_PASSWORD_FILE || undefined,
			caFile: env.JIRA_CA_FILE || undefined,
			testStatus: env.JIRA_TEST_STATUS || "Test",
			inProgressStatus: env.JIRA_IN_PROGRESS_STATUS || "In Progress",
			verifiedLabel: env.JIRA_VERIFIED_LABEL || "AgentTested",
			...loadQaLabels(env),
			...(env.QA_JIRA_APPROVE !== undefined ? { approve: list(env.QA_JIRA_APPROVE) } : {}),
		};
	}
	return {
		...loadWindowsEnvSettings({ ...env, PI_CONCURRENCY: env.PI_CONCURRENCY ?? "1" }, exists),
		ticketPattern,
		profilesFile: env.QA_PROFILES_FILE || undefined,
		browser: { channel: env.QA_BROWSER_CHANNEL || "msedge", allowHosts: allowHosts.length > 0 ? allowHosts : ["127.0.0.1", "localhost"] },
		jira,
	};
}

/** The files behind `JiraSettings`, read once at startup. The values never leave the harness. */
export function readJiraSecrets(settings: JiraSettings, read: (path: string) => Buffer = (path) => readFileSync(path)): { token: string; pfx?: Buffer; passphrase?: string; ca?: string } {
	const token = read(settings.tokenFile).toString("utf8").trim();
	if (!token) throw new Error("JIRA_TOKEN_FILE is empty");
	return {
		token,
		pfx: settings.pfxFile ? read(settings.pfxFile) : undefined,
		passphrase: settings.pfxPasswordFile ? read(settings.pfxPasswordFile).toString("utf8").replace(/[\r\n]+$/, "") : undefined,
		ca: settings.caFile ? read(settings.caFile).toString("utf8") : undefined,
	};
}
