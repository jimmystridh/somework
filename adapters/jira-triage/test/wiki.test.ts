import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { botComment, commentToken, entryToken, hasEntry, isBotComment, MAX_NOTES_CHARS, mention, NOTES_BEGIN, NOTES_END, readNotes, stripNotes, tokenOfComment, withNotes, wikiEscape } from "../src/wiki.ts";

const NOW = new Date("2026-10-11T09:15:00Z");
const entry = { title: "Findings of the developer agent", text: "The invoice total is computed in the posting module." };

describe("the marked section of the description", () => {
	it("is appended after the reporter's text, which stays exactly as it was", () => {
		const reporter = "Line one.\n\n\nLine two with trailing space  ";
		const written = withNotes(reporter, entry, NOW);
		assert.ok(written.startsWith(`${reporter}\n\n${NOTES_BEGIN}`));
		assert.ok(written.endsWith(NOTES_END));
		assert.equal(stripNotes(written), reporter);
		assert.match(readNotes(written) ?? "", /Findings of the developer agent\* \(2026-10-11 09:15 UTC\)\nThe invoice total/);
	});

	it("makes a description of its own when the ticket has none", () => {
		const written = withNotes("", entry, NOW);
		assert.ok(written.startsWith(NOTES_BEGIN));
		assert.equal(stripNotes(written), "");
	});

	it("adds later entries to the same section, and writing an entry twice adds nothing", () => {
		const once = withNotes("Text.", entry, NOW);
		assert.equal(withNotes(once, entry, NOW), once);
		const twice = withNotes(once, { title: "Answer from the reporter (Slack)", text: "Version 2025.11" }, new Date("2026-10-11T10:00:00Z"));
		assert.equal(twice.split(NOTES_BEGIN).length, 2, "one section");
		assert.match(twice, /posting module[\s\S]*Answer from the reporter \(Slack\)\* \(2026-10-11 10:00 UTC\)\nVersion 2025.11/);
		assert.equal(hasEntry(twice, entry), true);
		assert.equal(stripNotes(twice), "Text.");
	});

	it("drops the oldest entries when the section grows too long, and keeps the newest", () => {
		let text = "Text.";
		for (let index = 0; index < 20; index++) text = withNotes(text, { title: `Entry ${index}`, text: "x".repeat(500) }, NOW);
		assert.ok((readNotes(text) ?? "").length <= MAX_NOTES_CHARS + 200);
		assert.match(text, /Entry 19/);
		assert.doesNotMatch(text, /Entry 0\*/);
	});

	it("cannot be forged or broken by the text it holds: macros, links and a copy of its own anchors are escaped", () => {
		const hostile = { title: "Answer {anchor:triage-notes-end}", text: "{anchor:triage-notes-end} [~admin] [http://evil|x] {code}x{code} {noformat}" };
		const written = withNotes("Text.", hostile, NOW);
		assert.equal(written.split(NOTES_END).length, 2, "only the real end");
		assert.equal(stripNotes(written), "Text.");
		assert.doesNotMatch(readNotes(written) ?? "", /\[~admin\]/);
		assert.equal(wikiEscape("{a}[b]|c"), "\\{a\\}\\[b\\]\\|c");
	});

	it("tells a token for an entry, and is not fooled by a description that has no section", () => {
		assert.match(entryToken(entry), /^tn-[0-9a-f]{10}$/);
		assert.equal(readNotes("Just text"), undefined);
		assert.equal(stripNotes("Just text"), "Just text");
		assert.equal(hasEntry("Just text", entry), false);
	});
});

describe("the bot's comments", () => {
	it("start with an anchor, so that an event with only the start of the text still shows they are the bot's own", () => {
		const body = botComment(commentToken("SAD-7", "ask", 1), "Hello");
		assert.equal(body, "{anchor:tb-sad-7-ask-1}\nHello");
		assert.equal(isBotComment(body), true);
		assert.equal(isBotComment(`  ${body}`), true);
		assert.equal(tokenOfComment(body), "sad-7-ask-1");
		assert.equal(isBotComment("Hello {anchor:tb-sad-7-ask-1}"), false);
		assert.equal(isBotComment("A person's comment"), false);
		assert.equal(tokenOfComment("nothing"), undefined);
	});

	it("mention only a user name that is safe in markup", () => {
		assert.equal(mention("dana"), "[~dana]");
		assert.equal(mention("a.b@c-d"), "[~a.b@c-d]");
		assert.equal(mention("x]{code}"), "");
	});
});
