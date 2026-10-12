import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "deploy", "windows", "deploy-from-ci.ps1");
const source = readFileSync(SCRIPT, "utf8");
const pwsh = spawnSync("sh", ["-c", "command -v pwsh"], { encoding: "utf8" }).stdout.trim();
const skip = pwsh === "" ? "pwsh is not installed here" : false;

/** Loads only the named functions of the deployment script (found with the PowerShell parser) into a script of its own and runs a scenario with them. */
const HARNESS = `param([string]$Script, [string]$State, [string]$Scenario)
$errors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { [Console]::Error.WriteLine($errors[0].Message); exit 9 }
$wanted = @('Remove-Drain', 'Fail', 'Start-Drain')
foreach ($definition in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $wanted -contains $node.Name }, $true)) { . ([scriptblock]::Create($definition.Extent.Text)) }
$drainFile = $null
$role = 'qa'
$settings = @{}
if ($State) { $settings['PI_STATE_DIR'] = $State }
switch ($Scenario) {
    'start' { Start-Drain; Write-Host "drain file: $drainFile" }
    'start-then-fail' { Start-Drain; Fail 'the qa agent has been busy for 25 minutes' 3 }
    'fail-without-drain' { Fail 'nothing to remove' 4 }
    'start-then-remove' { Start-Drain; Remove-Drain; Remove-Drain; Write-Host 'removed twice' }
}
`;

function scenario(name: string, state: string | undefined) {
	const dir = mkdtempSync(join(tmpdir(), "windows-drain-"));
	const harness = join(dir, "harness.ps1");
	writeFileSync(harness, HARNESS);
	return spawnSync(pwsh, ["-NoProfile", "-File", harness, "-Script", SCRIPT, "-State", state ?? "", "-Scenario", name], { encoding: "utf8" });
}

const stateDir = (): string => {
	const dir = join(mkdtempSync(join(tmpdir(), "windows-state-")), "state");
	mkdirSync(dir);
	return dir;
};

describe("deploy-from-ci.ps1 draining", () => {
	it("is ASCII only and parses", { skip }, () => {
		assert.ok([...source].every((character) => character.charCodeAt(0) < 128), "Windows PowerShell 5.1 reads the file in the machine's code page");
		assert.equal(scenario("fail-without-drain", undefined).status, 4, "the parser found no errors: the scenario ran");
	});

	it("makes the file `drain` in PI_STATE_DIR of agent.env", { skip }, () => {
		const state = stateDir();
		const out = scenario("start", state);
		assert.equal(out.status, 0, out.stderr);
		assert.equal(existsSync(join(state, "drain")), true);
		assert.match(out.stdout, /draining the qa agent/);
	});

	it("takes the file away again on the Fail path, with the exit status and message of the failure", { skip }, () => {
		const state = stateDir();
		const out = scenario("start-then-fail", state);
		assert.equal(out.status, 3);
		assert.match(out.stderr, /busy for 25 minutes/);
		assert.equal(existsSync(join(state, "drain")), false, "a machine that could not be deployed is not left drained");
	});

	it("can take the file away twice, and a failure before any drain has nothing to take away", { skip }, () => {
		const state = stateDir();
		assert.match(scenario("start-then-remove", state).stdout, /removed twice/);
		assert.equal(existsSync(join(state, "drain")), false);
		const out = scenario("fail-without-drain", state);
		assert.equal(out.status, 4);
		assert.match(out.stderr, /nothing to remove/);
	});

	it("does not drain, and does not fail, when agent.env has no PI_STATE_DIR or the directory does not exist", { skip }, () => {
		const none = scenario("start", undefined);
		assert.equal(none.status, 0, none.stderr);
		assert.match(none.stdout, /not drained, only waited for/);
		const missing = scenario("start", join(tmpdir(), "windows-state-that-does-not-exist"));
		assert.equal(missing.status, 0, missing.stderr);
		assert.match(missing.stdout, /not drained/);
	});
});

describe("deploy-from-ci.ps1 order of events", () => {
	const lines = source.split("\n");
	const at = (pattern: RegExp): number => lines.findIndex((line) => pattern.test(line));

	it("drains before it waits for the running jobs, and stops the agent only after that", () => {
		assert.ok(at(/^Start-Drain$/) > 0);
		assert.ok(at(/^Start-Drain$/) < at(/^Wait-AgentIdle 1500$/), "the drain comes before the wait");
		assert.ok(at(/^Wait-AgentIdle 1500$/) < at(/^Stop-ScheduledTask -TaskName \$task/), "the agent is stopped after the wait");
	});

	it("removes the drain when the old agent is stopped, so the new code starts undrained", () => {
		const stop = at(/^Stop-ScheduledTask -TaskName \$task -ErrorAction SilentlyContinue$/);
		assert.match(lines[stop + 2] ?? "", /^Remove-Drain$/);
		assert.ok(stop + 2 < at(/^Install-Files$/));
	});

	it("removes it in every way out of the script: Fail, the trap and the success path", () => {
		assert.match(source, /function Fail\([^)]*\) \{[^}]*Remove-Drain; exit \$code \}/);
		const trap = source.slice(source.indexOf("trap {"), source.indexOf("\n}\n", source.indexOf("trap {")));
		assert.match(trap, /Remove-Drain[\s\S]*exit 1/);
		assert.match(source, /Remove-Drain\n\s*exit 0/);
	});

	it("has no other exit that could skip it", () => {
		const exits = lines.map((line, index) => ({ line: line.trim(), index })).filter(({ line }) => /(^|[;{]\s*)exit\b/.test(line) && !line.startsWith("#"));
		assert.equal(exits.length, 3, exits.map(({ line }) => line).join("\n"));
	});
});
