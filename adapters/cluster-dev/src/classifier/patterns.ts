/** What counts as secret material, the hypervisor and a firewall, as patterns the classifier applies to the words of a command. */

/** Token and key literals: a command that carries one handles a secret. */
export const CREDENTIAL_LITERALS: [RegExp, string][] = [
	[/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/, "a GitHub token"],
	[/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
	[/\bglpat-[A-Za-z0-9_-]{16,}/, "a GitLab token"],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
	[/\bxapp-[A-Za-z0-9-]{10,}/, "a Slack token"],
	[/\bsk-[A-Za-z0-9_-]{20,}/, "an API key"],
	[/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/, "a JSON web token"],
	[/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i, "a bearer token"],
	[/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i, "a password inside a URL"],
];

/** Names of variables whose value is a secret. */
export const SECRET_VARIABLE = /(?:TOKEN|SECRET|PASSW(?:OR)?D|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTHORIZATION|COOKIE|SESSION_?ID|BEARER|_KEY$|^KEY$)/i;

const EXAMPLE_ENV = /^\.env\.(?:example|sample|template|dist|defaults?)$/i;
const FILE_NAME = /\.(?:ts|tsx|js|mjs|cjs|rs|go|py|md|txt|json|yaml|yml|toml|sh|ps1|html|css|c|h|cpp|java|cs|log|conf)$/i;

/** `bare` entries are also secrets when written without a directory; the others only count in something that looks like a path (a bare `secret` is a word). */
const SECRET_BASENAMES: [RegExp, string, boolean][] = [
	[/^id_(?:rsa|dsa|ecdsa|ed25519)(?:-cert)?$/, "an ssh private key", true],
	[/\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg|pgp|ppk|age)$/i, "key material", true],
	[/^authorized_keys2?$/, "ssh key material", true],
	[/^(?:\.netrc|_netrc|\.git-credentials|\.pgpass|\.my\.cnf|\.vault-token|\.s3cfg|\.pypirc|\.dockercfg)$/, "a credentials file", true],
	[/^(?:credentials(?:\.json)?|auth\.json|secrets?\.(?:json|ya?ml|env|txt)|master\.key)$/i, "a credentials file", true],
	[/^(?:secrets?|tokens?|kubeconfig|shadow|gshadow)$/i, "a secret file", false],
	[/[-_.](?:token|secret|secrets|password|passwd|apikey|api-key)$/, "a secret file", true],
	[/(?:^|[-_.])(?:keys?|credentials?)\.json$/i, "a key file", true],
	[/service[-_]?account.*\.json$/i, "a service account key", true],
	[/\.(?:tfstate|tfvars)$/i, "infrastructure state with secrets", true],
	[/^agent\.key\.json$/, "an agent identity key", true],
	[/^ssh_host_\w+_key$/, "an ssh host key", true],
	[/^\.(?:bash_history|zsh_history|python_history|psql_history|mysql_history|node_repl_history|rediscli_history|lesshst|viminfo|sqlite_history)$/, "a shell or client history, which holds what was typed", true],
	[/^\.npmrc$/, "an npm configuration that can hold a registry token", false],
	[/^(?:config\.v2|hostconfig)\.json$/, "a container's configuration, which holds its environment", false],
];

/** A CA certificate or a chain, which is public, as opposed to the key it goes with (a file called just cert.pem may hold both, so it is still asked about). */
const PUBLIC_CERTIFICATE = /^(?!.*(?:key|priv|secret))(?:ca|[\w.-]*-ca|ca-[\w.-]*|chain|fullchain|[\w.-]*-chain)\.(?:pem|crt|cer)$|\.(?:crt|cer)$/i;

const SECRET_DIRECTORIES: [RegExp, string][] = [
	[/(?:^|\/)\.ssh(?:\/|$)/, "the ssh directory"],
	[/(?:^|\/)\.gnupg(?:\/|$)/, "the gpg directory"],
	[/(?:^|\/)\.aws(?:\/|$)/, "the AWS credentials"],
	[/(?:^|\/)\.azure(?:\/|$)/, "the Azure credentials"],
	[/(?:^|\/)\.kube(?:\/|$)/, "the kubernetes credentials"],
	[/(?:^|\/)\.config\/(?:gh|op|gcloud|git\/credentials)(?:\/|$)/, "a credentials directory"],
	[/(?:^|\/)\.docker\/config\.json$/, "the docker credentials"],
	[/(?:^|\/)\.password-store(?:\/|$)/, "the password store"],
	[/(?:^|\/)\.?secrets?\//i, "a secrets directory"],
	[/^\/run\/secrets(?:\/|$)/, "the mounted secrets"],
	[/^\/etc\/(?:shadow|gshadow|sudoers(?:\.d(?:\/|$)|$)|ssl\/private)/, "system secrets"],
	[/^\/proc\/[^/]+\/environ$/, "a process environment"],
	[/^\/var\/lib\/docker\/containers(?:\/|$)/, "the containers' configuration, which holds their environment"],
	[/(?:^|\/)1password(?:\/|$)/i, "1Password"],
	[/(?:^|\/)\.op(?:\/|$)/, "1Password"],
];

/** Strips a scheme, a leading `@` (curl) or `key=` (dd, options) so what is left can be read as a path. */
function pathCandidates(word: string): string[] {
	const out = [word];
	const withoutScheme = word.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?[^/]*(?=\/)/i, "");
	if (withoutScheme !== word) out.push(withoutScheme);
	const equals = /^-{0,2}[A-Za-z][A-Za-z0-9-]*=(.+)$/.exec(word);
	if (equals) out.push(equals[1]!);
	if (word.startsWith("@") || word.startsWith("<")) out.push(word.slice(1));
	const fileScheme = /^file:\/\/(.+)$/i.exec(word);
	if (fileScheme) out.push(fileScheme[1]!);
	const remote = /^[^/\s:@]+@?[^/\s:]*:(.+)$/.exec(word);
	if (remote) out.push(remote[1]!);
	return out;
}

/** Why a word names secret material, or undefined. Free text (anything with whitespace) is not a path. */
export function secretPathReason(word: string): string | undefined {
	if (word === "" || /\s/.test(word) || word.length > 400) return undefined;
	for (const candidate of pathCandidates(word)) {
		const path = candidate.replace(/\/+$/, "");
		for (const [pattern, label] of SECRET_DIRECTORIES) if (pattern.test(path)) return label;
		const name = path.slice(path.lastIndexOf("/") + 1);
		if (PUBLIC_CERTIFICATE.test(name)) continue;
		if (/^\.env(?:\..+)?$/.test(name) && !EXAMPLE_ENV.test(name)) return "an environment file that holds secrets";
		const pathLike = path.includes("/") || path.startsWith("~");
		for (const [pattern, label, bare] of SECRET_BASENAMES) if ((bare || pathLike) && pattern.test(name)) return label;
	}
	return undefined;
}

/** Why a text carries a secret literal, or undefined. */
export function credentialLiteralReason(text: string): string | undefined {
	for (const [pattern, label] of CREDENTIAL_LITERALS) if (pattern.test(text)) return label;
	return undefined;
}

/** The secret variables a text expands (`$GIT_TOKEN`, `${API_KEY}`). */
export function secretVariablesIn(text: string): string | undefined {
	for (const match of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) if (SECRET_VARIABLE.test(match[1]!)) return match[1];
	return undefined;
}

export const DEFAULT_HYPERVISOR_HOSTS = ["pve-host", "proxmox", "pve"];

/** Programs that exist only on a Proxmox hypervisor. */
export const HYPERVISOR_PROGRAMS = new Set(["qm", "pct", "pvesm", "pvesh", "pveum", "pvecm", "pveam", "pvenode", "pveceph", "pvereport", "pvesr", "pvedaemon", "pveproxy", "vzdump", "vzrestore", "qmrestore", "qmigrate", "zpool", "zfs", "proxmox-backup-client", "proxmox-backup-manager", "ha-manager", "corosync-cfgtool"]);

/** Whether a host name is the hypervisor. */
export function isHypervisorName(name: string, hosts: readonly string[]): boolean {
	const lower = name.toLowerCase().replace(/^.*@/, "").replace(/:\d+$/, "");
	return hosts.some((host) => host.toLowerCase() === lower) || (/^(?:pve|proxmox)(?:[-._0-9]|$)/.test(lower) && !FILE_NAME.test(lower));
}

/** Whether a word names the hypervisor as a host (`root@pve-host`, `pve-host:/path`, `https://pve-host:8006`, `HostName=pve-host`) or its API. */
export function hypervisorMention(word: string, hosts: readonly string[]): boolean {
	if (/:\/\/[^/\s]*:8006(?:\/|$)/.test(word) || /\/api2\/(?:json|extjs)\b/.test(word)) return true;
	const forms: string[] = [word];
	const url = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]*@)?([^/:\s]+)/i.exec(word);
	if (url) forms.push(url[1]!);
	const assigned = /^-{0,2}[A-Za-z][A-Za-z0-9-]*=(.+)$/.exec(word);
	if (assigned) forms.push(assigned[1]!);
	const scp = /^([^/\s:]+):/.exec(word);
	if (scp) forms.push(scp[1]!);
	return forms.some((form) => isHypervisorName(form, hosts) && !/[/\s]/.test(form.replace(/^[^@]*@/, "")));
}
