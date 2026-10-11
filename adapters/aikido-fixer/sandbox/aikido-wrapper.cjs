#!/usr/bin/env node
"use strict";
const { accessSync, constants, readFileSync, statSync } = require("node:fs");
const { spawnSync } = require("node:child_process");

const EX_UNAVAILABLE = 69;
const EX_CONFIG = 78;
const REGIONS = ["eu", "us", "me"];
const REAL_BINARY = process.env.AIKIDO_CLI_BINARY || "/opt/aikido/aikido";
const CLIENT_FILE = process.env.AIKIDO_SANDBOX_CLIENT_FILE || "/run/secrets/aikido-client.json";

function fail(message, code) {
	process.stderr.write(`aikido: ${message}\n`);
	process.exit(code);
}

function requireInstalledBinary(path) {
	try {
		accessSync(path, constants.X_OK);
		if (statSync(path).isFile() && statSync(path).size > 0) return;
	} catch {}
	fail(`the aikido CLI is not installed in this sandbox (nothing executable at ${path}); ask an operator to enable it`, EX_UNAVAILABLE);
}

function readClient(file) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		fail(`no Aikido credentials are mounted in this sandbox (${file}: ${error.code ?? "unreadable"}); ask an operator to enable them`, EX_CONFIG);
	}
	if (text.trim() === "") fail(`no Aikido credentials are mounted in this sandbox (${file} is empty); ask an operator to enable them`, EX_CONFIG);
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		fail(`the Aikido client file ${file} is not valid JSON`, EX_CONFIG);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail(`the Aikido client file ${file} needs clientId and clientSecret`, EX_CONFIG);
	const clientId = parsed.clientId ?? parsed.client_id;
	const clientSecret = parsed.clientSecret ?? parsed.client_secret;
	if (typeof clientId !== "string" || clientId === "" || typeof clientSecret !== "string" || clientSecret === "") fail(`the Aikido client file ${file} needs clientId and clientSecret`, EX_CONFIG);
	const { region, workspace } = parsed;
	if (region !== undefined && !REGIONS.includes(region)) fail(`the Aikido client file ${file} has an unknown region (use ${REGIONS.join(", ")})`, EX_CONFIG);
	if (workspace !== undefined && (typeof workspace !== "string" || workspace === "")) fail(`the Aikido client file ${file} has an empty workspace`, EX_CONFIG);
	return { clientId, clientSecret, region, workspace };
}

function environmentFor(client) {
	const inheritedRegion = process.env.AIKIDO_REGION;
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("AIKIDO_")));
	env.AIKIDO_CLIENT_ID = client.clientId;
	env.AIKIDO_CLIENT_SECRET = client.clientSecret;
	const region = client.region ?? inheritedRegion;
	if (region) env.AIKIDO_REGION = region;
	if (client.workspace) env.AIKIDO_WORKSPACE = client.workspace;
	return env;
}

requireInstalledBinary(REAL_BINARY);
const env = environmentFor(readClient(CLIENT_FILE));
const result = spawnSync(REAL_BINARY, process.argv.slice(2), { env, stdio: "inherit" });
if (result.error) fail(`the aikido CLI could not be started (${result.error.code ?? "error"})`, EX_UNAVAILABLE);
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
