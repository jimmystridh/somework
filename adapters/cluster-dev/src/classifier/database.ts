import { found, hasFlag, parseArgs, texts, type Call, type Finding } from "./common.ts";

/** SQL that changes data or structure. Looked for in every text the client is given. */
const SQL_WRITE = /\b(?:drop|delete\s+from|truncate|update\s+[\w."`\[\]]+\s+set|insert\s+(?:into|or)|replace\s+into|alter\s+(?:table|database|schema|index|role|user|system|sequence|view)|create\s+(?:table|database|schema|index|user|role|view|trigger|function|extension)|merge\s+into|grant|revoke|rename\s+(?:table|to)|vacuum\s+full|reindex|cluster\s|copy\s+[\w."]+\s+from|lo_unlink|pg_terminate_backend|pg_drop_replication_slot|detach\s+database|attach\s+database|load_extension)\b|\\copy\b.*\bfrom\b/i;
const SQL_READ_START = /^\s*(?:select|show|explain|describe|desc|with|values|table|pragma\s+(?:table_info|table_list|index_list|foreign_key_list|database_list|schema_version|user_version)|\\d\w*|\\l\b|\\dt|\\x|\\timing|\\conninfo|\.tables|\.schema|\.databases|\.indexes|\.headers|\.mode|\.width|\.help|\.quit)/i;

const SQL_FLAGS = ["-c", "--command", "-e", "--execute", "--eval", "--sql", "-q"];
const REDIS_READ = new Set(["ping", "info", "dbsize", "get", "mget", "exists", "type", "ttl", "pttl", "scan", "hget", "hmget", "hgetall", "hlen", "hkeys", "llen", "lrange", "scard", "smembers", "sismember", "zcard", "zrange", "zscore", "strlen", "memory", "client", "slowlog", "time", "lastsave", "xlen", "xrange", "xinfo", "pubsub", "latency", "--version", "-v", "--stat", "--latency", "--bigkeys", "--memkeys"]);
const MONGO_WRITE = /\b(?:drop\w*|delete(?:One|Many)|remove|update(?:One|Many)?|insert(?:One|Many)?|replaceOne|bulkWrite|createIndex|createCollection|renameCollection|findAndModify|findOneAndDelete|findOneAndUpdate|findOneAndReplace|save|shutdownServer|killOp|runCommand|adminCommand|eval)\b/;

export const DATABASE_PROGRAMS = new Set(["psql", "mysql", "mariadb", "sqlite3", "mongosh", "mongo", "redis-cli", "clickhouse-client", "influx", "cqlsh", "pg_restore", "mongorestore", "dropdb", "dropuser", "pg_dropcluster", "mysqladmin", "pg_ctl", "pg_ctlcluster", "createdb", "createuser", "pg_dump", "pg_dumpall", "mysqldump", "mongodump", "pg_isready", "vacuumdb", "reindexdb", "clusterdb", "psql.exe"]);

const ALWAYS = new Map<string, string>([
	["pg_restore", "pg_restore overwrites a database"],
	["mongorestore", "mongorestore overwrites a database"],
	["dropdb", "dropdb drops a database"],
	["dropuser", "dropuser drops a database role"],
	["pg_dropcluster", "pg_dropcluster drops a database cluster"],
	["mysqladmin", "mysqladmin changes or stops the server"],
	["pg_ctl", "pg_ctl starts or stops the server"],
	["pg_ctlcluster", "pg_ctlcluster starts or stops the server"],
	["createuser", "createuser changes database roles"],
	["vacuumdb", "vacuumdb rewrites tables"],
	["reindexdb", "reindexdb rebuilds indexes"],
	["clusterdb", "clusterdb rewrites tables"],
]);

/** A database client: only reading SQL is allowed without asking, and only when the SQL can be seen. */
export function classifyDatabase(call: Call): Finding | undefined {
	const program = call.program.replace(/\.exe$/, "");
	const always = ALWAYS.get(program);
	if (always) return found("data", always);
	if (["pg_dump", "pg_dumpall", "mysqldump", "mongodump", "pg_isready", "createdb"].includes(program)) return undefined;
	const args = call.args;
	if (program === "redis-cli") return redis(call);
	const parsed = parseArgs(args, [...SQL_FLAGS, "-h", "--host", "-p", "--port", "-U", "--username", "-u", "--user", "-d", "--dbname", "--database", "-f", "--file", "-o", "--output", "-F", "-R", "-v", "--set", "--csv"]);
	const passwordGiven = hasFlag(parsed, "--password", "--pass") || parsed.flags.some((flag) => flag.name.startsWith("--password=")) || ((program === "mysql" || program === "mariadb") && parsed.flags.some((flag) => flag.name === "-p" && flag.value !== undefined));
	if (passwordGiven) return found("secrets", `${program} was given a password on the command line`);
	if (hasFlag(parsed, "-f", "--file")) return found("data", `${program} runs SQL from a file that cannot be read here`);
	const sources: string[] = [];
	for (const flag of parsed.flags) if (SQL_FLAGS.includes(flag.name) && flag.value) sources.push(flag.value.text);
	if (program === "sqlite3") sources.push(...texts(parsed.positionals.slice(1)));
	if (program === "mongosh" || program === "mongo") sources.push(...texts(parsed.positionals).filter((entry) => !/^(?:mongodb(?:\+srv)?:\/\/|[\w.-]+(?::\d+)?\/?\w*$)/.test(entry)));
	if (program === "mysql" || program === "mariadb") {
		const execute = parsed.flags.find((flag) => flag.name === "-e" || flag.name === "--execute")?.value;
		if (execute) sources.push(execute.text);
	}
	const inputRedirect = call.io.stdinText;
	if (inputRedirect !== undefined) sources.push(inputRedirect);
	if (call.io.piped !== undefined) sources.push(call.io.piped);
	if (call.io.hasPipe && call.io.piped === undefined) return found("data", `${program} reads SQL from a pipe whose content cannot be seen`);
	if (sources.length === 0) return found("data", `${program} without a statement on the command line cannot be checked`);
	for (const source of sources) {
		if (program === "mongosh" || program === "mongo") {
			if (MONGO_WRITE.test(source)) return found("data", `${program} script that changes or drops data`);
			continue;
		}
		if (SQL_WRITE.test(source)) return found("data", "SQL that drops, deletes, truncates, updates or alters data or structure");
		for (const statement of source.split(";").map((part) => part.trim()).filter(Boolean)) if (!SQL_READ_START.test(statement)) return found("data", `SQL statement that is not a plain read: ${statement.slice(0, 40)}`);
	}
	return undefined;
}

function redis(call: Call): Finding | undefined {
	const parsed = parseArgs(call.args, ["-h", "-p", "-a", "-n", "-u", "--user", "--pass", "-i", "-r", "-c", "--scan", "--pattern", "--cacert", "--cert", "--key", "--sni"], true);
	if (hasFlag(parsed, "-a", "--pass", "--askpass") || parsed.flags.some((flag) => flag.name === "-u" && /:\/\/[^/]*@/.test(flag.value?.text ?? ""))) return found("secrets", "redis-cli was given a password on the command line");
	const command = parsed.positionals[0]?.text.toLowerCase();
	if (!command) return REDIS_READ.has(parsed.flags[0]?.name ?? "") ? undefined : found("data", "redis-cli without a command cannot be checked");
	if (command === "config") return found("secrets", "redis-cli config can print the password or change the server");
	return REDIS_READ.has(command) ? undefined : found("data", `redis-cli ${command.slice(0, 20)} changes or removes data`);
}
