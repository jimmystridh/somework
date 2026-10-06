import { createSign } from "node:crypto";

export interface GitHubAppOptions {
	appId: string;
	privateKeyPem: string;
	/** Needed when the app is installed more than once; with one installation it is found by itself. */
	installationId?: string;
	/** Repository names (not URLs) the minted token is narrowed to, within what the installation already allows. */
	repositories?: string[];
	apiBase?: string;
	fetch?: typeof fetch;
	/** Epoch milliseconds; injectable for tests. */
	now?: () => number;
	/** A cached token is replaced this long before it expires. */
	refreshMarginSeconds?: number;
}

const base64url = (value: Buffer | string): string => Buffer.from(value).toString("base64url");

/**
 * Installation tokens of one GitHub App: the app signs a short-lived JWT with its private key and exchanges it for a token that lasts an hour
 * and is limited to the installation's repositories and permissions. The token is cached and replaced shortly before it expires, so every git
 * command and API call of a long task sees a live one. Actions show up as `<slug>[bot]`, not as a person.
 */
export class GitHubAppCredentials {
	readonly #options: GitHubAppOptions;
	readonly #apiBase: string;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	#installationId?: string;
	#cached?: { token: string; expiresAt: number };
	#inflight?: Promise<string>;

	constructor(options: GitHubAppOptions) {
		if (!/^\d+$/.test(options.appId)) throw new Error("GITHUB_APP_ID must be the app's numeric id");
		if (!options.privateKeyPem.includes("PRIVATE KEY")) throw new Error("the GitHub App key file does not hold a PEM private key");
		this.#options = options;
		this.#installationId = options.installationId;
		this.#apiBase = (options.apiBase || "https://api.github.com").replace(/\/$/, "");
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
	}

	#jwt(): string {
		const issuedAt = Math.floor(this.#now() / 1000);
		const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: issuedAt - 60, exp: issuedAt + 540, iss: this.#options.appId }))}`;
		const signature = createSign("RSA-SHA256").update(unsigned).sign(this.#options.privateKeyPem);
		return `${unsigned}.${base64url(signature)}`;
	}

	async #call(method: string, path: string, bearer: string, body?: unknown): Promise<any> {
		const response = await this.#fetch(`${this.#apiBase}${path}`, {
			method,
			headers: { authorization: `Bearer ${bearer}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		if (!response.ok) throw new Error(`GitHub ${method} ${path} answered ${response.status}`);
		return response.json();
	}

	async #resolveInstallation(jwt: string): Promise<string> {
		if (this.#installationId) return this.#installationId;
		const installations = (await this.#call("GET", "/app/installations?per_page=10", jwt)) as { id: number }[];
		if (installations.length !== 1) throw new Error(`the app has ${installations.length} installations: set GITHUB_APP_INSTALLATION_ID`);
		this.#installationId = String(installations[0]!.id);
		return this.#installationId;
	}

	async #mint(): Promise<string> {
		const jwt = this.#jwt();
		const installation = await this.#resolveInstallation(jwt);
		const repositories = this.#options.repositories?.length ? { repositories: this.#options.repositories } : undefined;
		const minted = (await this.#call("POST", `/app/installations/${installation}/access_tokens`, jwt, repositories)) as { token: string; expires_at: string };
		this.#cached = { token: minted.token, expiresAt: Date.parse(minted.expires_at) };
		return minted.token;
	}

	/** A token that is valid for at least the refresh margin (default five minutes). Concurrent callers share one request. */
	async token(): Promise<string> {
		const margin = (this.#options.refreshMarginSeconds ?? 300) * 1000;
		if (this.#cached && this.#cached.expiresAt - this.#now() > margin) return this.#cached.token;
		this.#inflight ??= this.#mint().finally(() => {
			this.#inflight = undefined;
		});
		return this.#inflight;
	}

	/** The commit author GitHub attributes to the app: `<slug>[bot]` and the noreply address with the bot account's id. */
	async identity(): Promise<{ name: string; email: string }> {
		const app = (await this.#call("GET", "/app", this.#jwt())) as { slug: string };
		const login = `${app.slug}[bot]`;
		const bot = (await this.#call("GET", `/users/${encodeURIComponent(login)}`, await this.token())) as { id: number };
		return { name: login, email: `${bot.id}+${login}@users.noreply.github.com` };
	}
}
