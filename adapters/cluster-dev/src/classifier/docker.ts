import { checkWrite, found, hasFlag, parseArgs, type Call, type Finding, type Settings } from "./common.ts";
import type { Word } from "./shell.ts";
import { secretPathReason } from "./patterns.ts";

const DOCKER_GLOBAL_VALUED = ["-H", "--host", "--context", "-c", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"];
const COMPOSE_GLOBAL_VALUED = ["-f", "--file", "-p", "--project-name", "--project-directory", "--profile", "--env-file", "--ansi", "--progress", "--parallel"];

/** Subcommands that look at containers or restart them: the repository's stacks are rolled with these. */
const SAFE = new Set(["ps", "images", "logs", "stats", "top", "port", "version", "info", "events", "diff", "history", "wait", "restart", "stop", "start", "kill", "pause", "unpause", "pull", "build", "buildx", "tag", "rename", "search"]);
const COMPOSE_SAFE = new Set(["restart", "start", "stop", "pause", "unpause", "ps", "ls", "logs", "top", "images", "port", "version", "events", "pull", "build", "kill", "wait", "create", "watch", "stats", "up"]);
const EXEC_VALUED = ["-e", "--env", "-u", "--user", "-w", "--workdir", "--env-file", "--detach-keys", "--index"];
const RUN_VALUED = ["-e", "--env", "-v", "--volume", "--mount", "-p", "--publish", "-w", "--workdir", "-u", "--user", "--name", "--network", "--net", "--entrypoint", "--env-file", "-l", "--label", "-m", "--memory", "--cpus", "--restart", "--platform", "--pull", "-h", "--hostname", "--add-host", "--dns", "--log-driver", "--cap-add", "--cap-drop", "--security-opt", "--device", "--group-add", "--pid", "--ipc", "--volumes-from", "--shm-size", "--tmpfs", "--stop-signal", "--health-cmd", "--entrypoint", "--user", "--init-path", "--expose", "-a", "--attach", "--cidfile", "--cgroupns", "--ulimit", "--userns", "--runtime", "--gpus", "--link", "--ip", "--mac-address", "--sysctl", "--storage-opt", "--label-file", "--log-opt", "--pids-limit", "--memory-swap", "--blkio-weight", "--cpu-shares", "--cpuset-cpus", "--domainname", "--dns-search", "--dns-option", "--stop-timeout", "--workdir", "--health-interval", "--health-retries", "--health-timeout", "--health-start-period", "--annotation", "--isolation", "--kernel-memory", "--oom-score-adj", "--read-only-tmpfs"];

const INSPECT_ENV = /Env|\{\{\s*json|\{\{\s*\.\s*\}\}|\.Config\s*\}\}|\.Config\s*\||\.HostConfig\s*\}\}|\.Mounts\s*\}\}.*Env|printf|\{\{\s*range\s+\.Config/;

/** Whether `container:path` names something inside a container (docker cp). */
const inContainer = (operand: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_.-]*:/.test(operand) && !operand.startsWith("/") && !operand.startsWith(".");

function inspect(args: Word[]): Finding | undefined {
	const parsed = parseArgs(args, ["-f", "--format", "--type"]);
	const format = parsed.flags.find((flag) => flag.name === "-f" || flag.name === "--format")?.value;
	if (!format || format.dynamic || INSPECT_ENV.test(format.text)) return found("secrets", "docker inspect prints the container's environment (secrets) unless its format picks harmless fields");
	return undefined;
}

function copy(args: Word[], settings: Settings): Finding | undefined {
	const parsed = parseArgs(args, ["-a", "-L"]);
	const [source, destination] = parsed.positionals;
	if (!source || !destination) return found("unknown", "docker cp needs a source and a destination");
	if (inContainer(destination.text) || destination.dynamic) return found("data", "docker cp into a container overwrites files inside it");
	for (const operand of [source, destination]) {
		const reason = secretPathReason(operand.text.replace(/^[^/:]+:/, ""));
		if (reason) return found("secrets", `docker cp of ${reason}`);
	}
	return checkWrite(destination, "docker cp writes", settings);
}

/** Options that give a container more reach than a throwaway tool needs. */
function runProblem(parsed: ReturnType<typeof parseArgs>): Finding | undefined {
	if (hasFlag(parsed, "--privileged")) return found("system", "docker run --privileged gives the container the host");
	for (const flag of parsed.flags) {
		const value = flag.value?.text ?? "";
		if (["-v", "--volume", "--mount", "--volumes-from", "--device"].includes(flag.name)) return found("data", `docker run ${flag.name} mounts host storage into the container`);
		if (["--pid", "--ipc", "--userns", "--cgroupns"].includes(flag.name) && value === "host") return found("system", `docker run ${flag.name} host shares the host's namespace`);
		if (["--network", "--net"].includes(flag.name) && value === "host") return found("system", "docker run --network host shares the host's network");
		if (["--cap-add", "--security-opt"].includes(flag.name)) return found("system", `docker run ${flag.name} weakens the container's confinement`);
	}
	return undefined;
}

function exec(args: Word[], call: Call, settings: Settings): Finding | undefined {
	const parsed = parseArgs(args, EXEC_VALUED, true);
	if (hasFlag(parsed, "--privileged")) return found("system", "docker exec --privileged gives the command the host");
	const [, ...command] = parsed.positionals;
	if (command.length === 0) return found("unknown", "docker exec without a command opens an interactive session");
	return call.runWords(command, { ...settings, workspaces: [] });
}

function run(args: Word[], call: Call, settings: Settings): Finding | undefined {
	const parsed = parseArgs(args, RUN_VALUED, true);
	const problem = runProblem(parsed);
	if (problem) return problem;
	if (!hasFlag(parsed, "--rm")) return found("system", "docker run without --rm leaves a container behind");
	const [, ...command] = parsed.positionals;
	const entrypoint = parsed.flags.find((flag) => flag.name === "--entrypoint")?.value;
	const words = entrypoint ? [entrypoint, ...command] : command;
	return words.length > 0 ? call.runWords(words, { ...settings, workspaces: [] }) : undefined;
}

function classifyDockerSub(sub: string, rest: Word[], call: Call): Finding | undefined {
	const first = rest.find((entry) => !entry.text.startsWith("-"))?.text;
	switch (sub) {
		case "inspect":
			return inspect(rest);
		case "exec":
			return exec(rest, call, call.settings);
		case "run":
			return run(rest, call, call.settings);
		case "cp":
			return copy(rest, call.settings);
		case "rm":
			return found("data", "docker rm removes containers and what they hold");
		case "rmi":
			return found("data", "docker rmi removes images, which rollbacks need");
		case "prune":
			return found("data", "docker prune removes unused data for good");
		case "push":
			return found("system", "docker push publishes an image");
		case "login":
		case "logout":
		case "secret":
		case "config":
			return found("secrets", `docker ${sub} handles credentials`);
		case "volume":
			return ["ls", "list", "inspect", "create"].includes(first ?? "") ? undefined : found("data", `docker volume ${first ?? ""} removes or changes volumes`.trim());
		case "network":
			return ["ls", "list", "inspect", "create", "connect"].includes(first ?? "") ? undefined : found("system", `docker network ${first ?? ""} removes or changes networks`.trim());
		case "image":
			if (["ls", "list", "inspect", "history", "pull", "build", "tag"].includes(first ?? "")) return first === "inspect" ? inspect(rest.slice(1)) : undefined;
			return found("data", `docker image ${first ?? ""} removes or publishes images`.trim());
		case "container": {
			if (!first) return undefined;
			const index = rest.findIndex((entry) => entry.text === first);
			const inner = rest.slice(index + 1);
			if (first === "inspect") return inspect(inner);
			if (first === "exec") return exec(inner, call, call.settings);
			if (first === "run") return run(inner, call, call.settings);
			if (first === "cp") return copy(inner, call.settings);
			if (first === "rm") return found("data", "docker container rm removes containers and what they hold");
			if (first === "prune") return found("data", "docker container prune removes stopped containers");
			return classifyDockerSub(first, inner, call);
		}
		case "system":
			return ["df", "info", "events"].includes(first ?? "") ? undefined : found("data", `docker system ${first ?? ""} removes unused data for good`.trim());
		case "builder":
		case "buildx":
			return first === "prune" || first === "rm" ? found("data", "docker builder prune removes build cache") : undefined;
		default:
			if (SAFE.has(sub)) return undefined;
			if (/prune$/.test(sub)) return found("data", "docker prune removes unused data for good");
			return found("unknown", `docker ${sub.slice(0, 40)} is not a docker command this agent may run without asking`);
	}
}

function classifyCompose(args: Word[], call: Call): Finding | undefined {
	const parsed = parseArgs(args, COMPOSE_GLOBAL_VALUED, true);
	const [subWord, ...rest] = parsed.positionals;
	if (!subWord) return undefined;
	const sub = subWord.text;
	const flags = parseArgs(rest, ["-e", "--env", "-u", "--user", "-w", "--workdir", "--index", "-v", "--volume", "--name", "--entrypoint", "-p", "--publish", "--scale", "-t", "--timeout", "--wait-timeout", "-n", "--tail", "--since", "--until", "--profile", "--pull", "--format", "--filter", "-l", "--label"]);
	for (const flag of parsed.flags) {
		const reason = flag.value ? secretPathReason(flag.value.text) : undefined;
		if (reason && flag.name === "--env-file") return found("secrets", `docker compose --env-file reads ${reason}`);
	}
	switch (sub) {
		case "up":
			if (hasFlag(flags, "-V", "--renew-anon-volumes")) return found("data", "docker compose up -V throws away the data in anonymous volumes");
			if (hasFlag(flags, "--remove-orphans")) return found("data", "docker compose up --remove-orphans removes containers that are not in the compose file");
			return undefined;
		case "down":
			if (hasFlag(flags, "-v", "--volumes")) return found("data", "docker compose down --volumes removes the stack's volumes");
			if (hasFlag(flags, "--rmi")) return found("data", "docker compose down --rmi removes images");
			if (hasFlag(flags, "--remove-orphans")) return found("data", "docker compose down --remove-orphans removes containers that are not in the compose file");
			return undefined;
		case "rm":
			return found("data", "docker compose rm removes containers and, with -v, their volumes");
		case "config":
			return hasFlag(flags, "-q", "--quiet", "--services", "--volumes", "--profiles", "--images", "--hash", "--no-interpolate") ? undefined : found("secrets", "docker compose config prints the resolved environment (secrets)");
		case "exec": {
			const execArgs = parseArgs(rest, ["-e", "--env", "-u", "--user", "-w", "--workdir", "--index"], true);
			if (hasFlag(execArgs, "--privileged")) return found("system", "docker compose exec --privileged gives the command the host");
			const [, ...command] = execArgs.positionals;
			return command.length === 0 ? found("unknown", "docker compose exec without a command opens an interactive session") : call.runWords(command, { ...call.settings, workspaces: [] });
		}
		case "run": {
			const runArgs = parseArgs(rest, ["-e", "--env", "-u", "--user", "-w", "--workdir", "-v", "--volume", "--name", "--entrypoint", "-p", "--publish", "-l", "--label", "--use-aliases"], true);
			const problem = runProblem(runArgs);
			if (problem) return problem;
			const entrypoint = runArgs.flags.find((flag) => flag.name === "--entrypoint")?.value;
			const [, ...command] = runArgs.positionals;
			const words = entrypoint ? [entrypoint, ...command] : command;
			return words.length > 0 ? call.runWords(words, { ...call.settings, workspaces: [] }) : undefined;
		}
		case "cp":
			return copy(rest, call.settings);
		case "push":
		case "publish":
			return found("system", `docker compose ${sub} publishes an image`);
		default:
			return COMPOSE_SAFE.has(sub) ? undefined : found("unknown", `docker compose ${sub.slice(0, 40)} is not a command this agent may run without asking`);
	}
}

/** `docker`, `podman` and `docker-compose`. */
export function classifyDocker(call: Call): Finding | undefined {
	if (call.program === "docker-compose" || call.program === "podman-compose") return classifyCompose(call.args, call);
	const args = call.args;
	let i = 0;
	for (; i < args.length && args[i]!.text.startsWith("-"); i++) {
		const arg = args[i]!.text;
		if (arg === "-H" || arg === "--host" || arg.startsWith("--host=") || arg.startsWith("-H")) return found("system", "docker talks to another daemon (-H)");
		if (arg === "--context" || arg === "-c") return found("system", "docker uses another context (it may be a remote daemon)");
		if (DOCKER_GLOBAL_VALUED.includes(arg)) i++;
	}
	const sub = args[i];
	if (!sub) return undefined;
	if (sub.dynamic) return found("unknown", "docker was given a computed subcommand");
	const rest = args.slice(i + 1);
	if (sub.text === "compose") return classifyCompose(rest, call);
	return classifyDockerSub(sub.text, rest, call);
}

