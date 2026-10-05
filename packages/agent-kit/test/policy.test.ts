import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { approvalPolicy, DEFAULT_APPROVAL_PATTERNS } from "../src/policy.ts";
import { WINDOWS_APPROVAL_PATTERNS } from "../src/windows/approvals.ts";

describe("approval policy", () => {
	it("keeps asking about risky bash commands", () => {
		const policy = approvalPolicy([], DEFAULT_APPROVAL_PATTERNS);
		assert.match(policy.needsApproval("bash", { command: "sudo ls" }) ?? "", /root/);
		assert.equal(policy.needsApproval("bash", { command: "ls" }), undefined);
		assert.equal(policy.needsApproval("read", { path: "x" }), undefined);
	});

	it("asks about the tools a role names, with the summary the role builds from the arguments", () => {
		const policy = approvalPolicy([], DEFAULT_APPROVAL_PATTERNS, {
			ticket_comment: (args) => `comment on ${String(args.key)}`,
			ticket_peek: () => undefined,
		});
		assert.equal(policy.needsApproval("ticket_comment", { key: "T-1" }), "comment on T-1");
		assert.equal(policy.needsApproval("ticket_peek", { key: "T-1" }), undefined);
		assert.equal(policy.needsApproval("other", {}), undefined);
	});

	it("never takes a tool approval from the prototype", () => {
		const policy = approvalPolicy([], DEFAULT_APPROVAL_PATTERNS, {});
		for (const tool of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.equal(policy.needsApproval(tool, {}), undefined, tool);
	});

	it("a role's tool approval does not replace the bash patterns", () => {
		const policy = approvalPolicy([], DEFAULT_APPROVAL_PATTERNS, { ticket_comment: () => "x" });
		assert.match(policy.needsApproval("bash", { command: "git push origin x" }) ?? "", /push/);
	});

	it("the Windows patterns add machine-level changes to the defaults", () => {
		const policy = approvalPolicy([], WINDOWS_APPROVAL_PATTERNS);
		for (const command of ["reg add HKLM\\x /v y", "schtasks /create /tn x", "net user a b", "powershell -enc AAAA", "shutdown /r", "sudo ls"]) assert.ok(policy.needsApproval("bash", { command }), command);
		assert.equal(policy.needsApproval("bash", { command: "git status" }), undefined);
	});
});
