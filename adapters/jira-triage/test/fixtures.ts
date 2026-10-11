import type { Subject } from "../src/checklist.ts";

export const subject = (over: Partial<Subject> = {}): Subject => ({ type: "Bug", summary: "Total is wrong on the invoice", description: "", environment: "", components: [], attachments: [], ...over });

/** A bug as people write it: complete, in English. */
export const COMPLETE_BUG = `Steps to reproduce:
1. Open the invoice for customer Acme AB (556677-8899)
2. Add two rows of 100 kr with 25% VAT
3. Click Save

Expected: the total shows 250 kr.
Actual: the total shows 200 kr and the VAT line is missing.

Version 2025.11.8637 on the test environment, Edge.`;

export const COMPLETE_BUG_SV = `Så här återskapar du:
1. Öppna fakturan för bolaget Acme AB
2. Lägg till två rader om 100 kr med 25% moms
3. Klicka på Spara

Förväntat resultat: summan blir 250 kr.
Faktiskt resultat: summan blir 200 kr och momsraden saknas.

Version 2025.11 i testmiljön.`;

export const COMPLETE_STORY = `As an accountant I want to export the VAT report to Excel so that I can send it to the auditor without retyping.

Acceptance criteria:
- the export button is on the VAT report
- the file has one row per VAT code
- the totals match the report on screen`;

export const COMPLETE_STORY_SV = `Som redovisningskonsult vill jag exportera momsrapporten till Excel för att kunna skicka den till revisorn utan att skriva om den.

Acceptanskriterier:
- exportknappen finns på momsrapporten
- filen har en rad per momskod`;

export const BARE_BUG = "The total is wrong.";
export const BARE_STORY = "We should have an export.";
