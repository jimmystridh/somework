import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHECKLISTS, definitionOf, evaluate, issueKind, ITEM_IDS } from "../src/checklist.ts";
import { BARE_BUG, BARE_STORY, COMPLETE_BUG, COMPLETE_BUG_SV, COMPLETE_STORY, COMPLETE_STORY_SV, subject } from "./fixtures.ts";

const missingOf = (over: Parameters<typeof subject>[0], evidence?: Parameters<typeof evaluate>[1]) => evaluate(subject(over), evidence).missing.map((item) => item.id);

describe("which checklist a ticket gets", () => {
	it("reads the issue type, in English and Swedish, and gives anything else the minimal list", () => {
		for (const type of ["Bug", "bug", "Defect", "Bugg", "Fel", " Bug "]) assert.equal(issueKind(type), "bug", type);
		for (const type of ["Story", "User Story", "Task", "Sub-task", "Improvement", "New Feature", "Förbättring", "Uppgift"]) assert.equal(issueKind(type), "story", type);
		for (const type of ["Epic", "Support", "", "Initiative"]) assert.equal(issueKind(type), "other", type);
	});

	it("has the items the owner asked for, per kind", () => {
		assert.deepEqual(CHECKLISTS.bug.map((item) => item.id), ["reproduction-steps", "expected-actual", "environment-version", "affected-customer", "attachment"]);
		assert.deepEqual(CHECKLISTS.story.map((item) => item.id), ["goal", "acceptance-criteria"]);
		assert.deepEqual(CHECKLISTS.other.map((item) => item.id), ["summary", "description"]);
		assert.deepEqual([...ITEM_IDS].sort(), ["acceptance-criteria", "affected-customer", "attachment", "description", "environment-version", "expected-actual", "goal", "reproduction-steps", "summary"]);
	});

	it("marks the technical items, the ones a developer can say something about", () => {
		assert.deepEqual(CHECKLISTS.bug.filter((item) => item.technical).map((item) => item.id), ["reproduction-steps", "environment-version"]);
		assert.deepEqual(CHECKLISTS.bug.filter((item) => item.resolvableByDeveloper).map((item) => item.id), ["reproduction-steps"]);
		assert.equal(definitionOf("goal")?.label, "why this is wanted (the goal)");
		assert.equal(definitionOf("nonsense"), undefined);
	});
});

describe("a bug", () => {
	it("with steps, expected and actual result, environment and version and a customer is complete", () => {
		const verdict = evaluate(subject({ description: COMPLETE_BUG }));
		assert.equal(verdict.kind, "bug");
		assert.equal(verdict.complete, true, JSON.stringify(verdict.missing));
		assert.equal(verdict.items.find((item) => item.id === "attachment")?.status, "not_applicable", "nothing in it is about the user interface");
	});

	it("is complete in Swedish too", () => {
		const verdict = evaluate(subject({ summary: "Summan blir fel", description: COMPLETE_BUG_SV, attachments: [{ filename: "skarmbild.png" }] }));
		assert.equal(verdict.complete, true, JSON.stringify(verdict.missing));
	});

	it("that says only that something is wrong misses everything but what it cannot be judged on", () => {
		assert.deepEqual(missingOf({ description: BARE_BUG, summary: "Total wrong" }), ["reproduction-steps", "expected-actual", "environment-version", "affected-customer"]);
	});

	it("misses steps when there is no list, no steps heading and no actions", () => {
		const missing = missingOf({ description: "Expected 250 but got 200 for customer Acme, version 2025.11." });
		assert.deepEqual(missing, ["reproduction-steps"]);
	});

	it("accepts steps written as a list, as a heading with content, or as a sentence of actions", () => {
		const base = "Expected 250 but actually 200. Customer Acme, version 2025.11.";
		assert.deepEqual(missingOf({ description: `${base}\n# open the invoice\n# save it` }), []);
		assert.deepEqual(missingOf({ description: `${base}\nSteps to reproduce: create an invoice with two rows and save it twice` }), []);
		assert.deepEqual(missingOf({ description: `${base}\nOpen the invoice, add a row and click Save.` }), []);
		assert.deepEqual(missingOf({ description: `${base}\nSteps to reproduce:` }), ["reproduction-steps"], "a heading with nothing under it is not steps");
	});

	it("needs both halves of expected versus actual", () => {
		const rest = "1. open the invoice\n2. save it\nCustomer Acme, version 2025.11.";
		assert.deepEqual(missingOf({ summary: "Invoice total", description: `The total is odd.\n${rest}` }), ["expected-actual"]);
		assert.deepEqual(missingOf({ summary: "Invoice total", description: `The total is wrong.\n${rest}` }), ["expected-actual"]);
		assert.deepEqual(missingOf({ summary: "Invoice total", description: `It should show 250.\n${rest}` }), ["expected-actual"]);
		assert.deepEqual(missingOf({ summary: "Invoice total", description: `It should show 250 but shows 200.\n${rest}` }), []);
		assert.deepEqual(missingOf({ description: `It should show 250.\n${rest}` }), [], "a summary that says what is wrong counts as the actual result");
		assert.deepEqual(missingOf({ description: `Förväntat: 250. Faktiskt: 200.\n${rest}` }), []);
	});

	it("takes the environment from its field or from a version or an environment word in the text", () => {
		const rest = "1. open the invoice\n2. save it\nIt should show 250 but shows 200 for customer Acme.";
		assert.deepEqual(missingOf({ description: rest }), ["environment-version"]);
		assert.deepEqual(missingOf({ description: rest, environment: "Production, Chrome 130" }), []);
		assert.deepEqual(missingOf({ description: `${rest} Seen in production.` }), []);
		assert.deepEqual(missingOf({ description: `${rest} Version 2025.11` }), []);
		assert.deepEqual(missingOf({ description: `${rest} Build 8637` }), []);
		assert.deepEqual(missingOf({ description: rest, environment: "  " }), ["environment-version"]);
	});

	it("needs a company or customer, recognised by the word or an organisation number", () => {
		const rest = "1. open the invoice\n2. save it\nIt should show 250 but shows 200 in version 2025.11.";
		assert.deepEqual(missingOf({ description: rest }), ["affected-customer"]);
		assert.deepEqual(missingOf({ description: `${rest} Reported by a customer.` }), []);
		assert.deepEqual(missingOf({ description: `${rest} Bolaget har inte fått det rätt.` }), []);
		assert.deepEqual(missingOf({ description: `${rest} 556677-8899` }), []);
	});

	it("needs a screenshot or a recording only when it is about the user interface", () => {
		const text = `${COMPLETE_BUG}\nThe Save button is greyed out.`;
		assert.deepEqual(missingOf({ description: text }), ["attachment"]);
		assert.deepEqual(missingOf({ description: text, attachments: [{ filename: "screen.png" }] }), []);
		assert.deepEqual(missingOf({ description: text, attachments: [{ filename: "recording", mimeType: "video/mp4" }] }), []);
		assert.deepEqual(missingOf({ description: `${text}\n!screen.png!` }), []);
		assert.deepEqual(missingOf({ description: `${text}\nSee https://files.example.test/shot.png` }), []);
		assert.deepEqual(missingOf({ description: text, attachments: [{ filename: "notes.txt" }] }), ["attachment"], "a text file is not a screenshot");
		assert.deepEqual(missingOf({ description: "Steps:\n1. call the API\n2. read the total\nExpected 250 but got 200 for customer Acme, version 1.2.3, server error." }), [], "an API problem needs no screenshot");
		assert.deepEqual(missingOf({ description: "Steps:\n1. call the API\n2. read the total\nExpected 250 but got 200 for customer Acme, version 1.2.3.", components: ["web-ui"] }), ["attachment"], "a UI component makes it a UI ticket");
	});

	it("reads the summary and the environment field as part of the text", () => {
		assert.deepEqual(missingOf({ summary: "Customer Acme sees wrong total in version 2025.11, expected 250 but got 200", description: "1. open it\n2. save it" }), []);
	});
});

describe("a story, task or improvement", () => {
	it("with a goal and acceptance criteria is complete, in English and Swedish", () => {
		assert.equal(evaluate(subject({ type: "Story", description: COMPLETE_STORY })).complete, true);
		assert.equal(evaluate(subject({ type: "Improvement", description: COMPLETE_STORY_SV })).complete, true);
	});

	it("without either misses both", () => {
		assert.deepEqual(missingOf({ type: "Task", description: BARE_STORY }), ["goal", "acceptance-criteria"]);
		assert.deepEqual(missingOf({ type: "Story", description: "" }), ["goal", "acceptance-criteria"]);
	});

	it("takes the goal from its cue words and the criteria from a phrase, a given-when-then or a list of three", () => {
		assert.deepEqual(missingOf({ type: "Task", description: "We want this because the auditor asks for it. It is done when the report exports." }), []);
		assert.deepEqual(missingOf({ type: "Task", description: "Export it in order to save time.\nGiven a report when I click export then I get a file." }), []);
		assert.deepEqual(missingOf({ type: "Task", description: "The goal is less typing.\n- one\n- two\n- three" }), []);
		assert.deepEqual(missingOf({ type: "Task", description: "The goal is less typing.\n- one\n- two" }), ["acceptance-criteria"]);
		assert.deepEqual(missingOf({ type: "Task", description: "Add an export.\nAcceptance criteria: a file is produced." }), ["goal"]);
	});
});

describe("any other ticket", () => {
	it("needs a summary and a description, and nothing else", () => {
		assert.deepEqual(missingOf({ type: "Epic", summary: "Reporting", description: "" }), ["summary", "description"], "one word is not a summary");
		assert.deepEqual(missingOf({ type: "Epic", summary: "Reporting overhaul for the year end", description: "" }), ["description"]);
		assert.deepEqual(missingOf({ type: "Epic", summary: "Reporting overhaul for the year end", description: "A few sentences about what this is." }), []);
		assert.deepEqual(missingOf({ type: "", summary: "Reporting overhaul for the year end", description: "short" }), ["description"]);
	});
});

describe("what comes in after the ticket was written", () => {
	it("counts the reporter's answers as part of the ticket", () => {
		const first = evaluate(subject({ description: "The total is wrong. Customer Acme." }));
		assert.deepEqual(first.missing.map((item) => item.id), ["reproduction-steps", "expected-actual", "environment-version"]);
		const answered = evaluate(subject({ description: "The total is wrong. Customer Acme." }), { replies: ["1. open the invoice\n2. save it\nIt should show 250 but shows 200.\nVersion 2025.11"], findings: {} });
		assert.equal(answered.complete, true);
	});

	it("lets the developer agent close the steps, and nothing the reporter alone can say", () => {
		const text = "It should show 250 but shows 200. Customer Acme, version 2025.11.";
		assert.deepEqual(missingOf({ description: text }, { replies: [], findings: { "reproduction-steps": "Open the invoice form and save a two-row invoice." } }), []);
		const resolved = evaluate(subject({ description: text }), { replies: [], findings: { "reproduction-steps": "Open the invoice form and save a two-row invoice." } });
		assert.equal(resolved.items.find((item) => item.id === "reproduction-steps")?.resolvedBy, "developer");
		assert.deepEqual(missingOf({ description: "Steps:\n1. a\n2. b\nShould show 250 but shows 200. Customer Acme." }, { replies: [], findings: { "environment-version": "Exists since release 2025.11, affected builds unknown." } }), ["environment-version"], "the reporter's own environment cannot be found in the code");
		assert.deepEqual(missingOf({ description: text }, { replies: [], findings: { "reproduction-steps": "short" } }), ["reproduction-steps"], "a finding with nothing in it closes nothing");
	});
});
