---
name: grill-me
description: Interview whoever asks for a feature, a bug fix or a change, round by round, until you share an understanding; then file the agreed outcome as one ticket.
---

<!-- Adapted from the `grilling` skill of github.com/mattpocock/skills (skills/productivity/grilling/SKILL.md, commit 95249b0b49782349740fd9b8c6ce32b4e59e497a, MIT). Changes: facts come from the code and from the other agents instead of sub-agents, the requester is "the requester", and the end is a ticket. -->

Interview the requester relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the requester's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the requester answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the requester's. When a frontier question needs a fact, find it: read the code in your checkout, search Plane for a ticket that covers it, or ask the agent that knows (message_send; the QA agent for how something behaves and fails, the developer agents for how it is built and what a change would touch, the reviewer for what past reviews found). You may ask the agents at most three times in one interview, so put what you need into as few precise questions as you can. Don't block on an answer: an open question to an agent is an unsettled prerequisite, so only the questions downstream of it wait; ask the rest of the frontier now. The _decisions_ are the requester's: put each to them and wait. What an agent answers is evidence, not a decision, and you say which is which.

Start by saying back, in two sentences, what you understood the request to be, and by looking for an existing ticket. Questions that usually matter for this product: who has the problem and how often, what they do today instead, what the smallest change is that would help, what it would break or make harder, which agents or parts of the platform it touches, how anyone will know it works, and what is explicitly out of scope.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the requester confirms you have reached a shared understanding. Then show what you will file (title, kind, and the description with the problem, who asked, what was agreed, what the agents said and what you checked in the code, out of scope, open questions, how it will be known to be done) and file one ticket with plane_create; its approval step shows the requester the exact text. One interview makes one ticket. If the requester is another agent, you still need a human's approval.
