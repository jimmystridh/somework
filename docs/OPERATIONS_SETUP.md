# Operations: agent setup, catalog, library and fleet limits

The build plan of ADR 0004. The glossary is in `CONTEXT.md` (Setup override, Operations, MCP catalog, Skill library, Fleet limits). The wire format between Operations and an agent is `packages/agent-kit/src/setup/contract.ts` and is the source of truth for both sides; the Rust side must accept and produce exactly that JSON.

## Roles of the parts

- **Operations** (`dashboard/`, Rust: `shared`, `server`, `ui`): Postgres, Entra sign-in, the Agents section, the editors for Setup, MCP catalog, skill library and fleet limits. It is the only sender of setup documents (service principal `operations`, its own signing key).
- **Agents** (kit, `packages/agent-kit`): accept a document only from `service:operations`, apply it, report it in `/profile` under `setup`.
- **Manager** (`adapters/manager`): applies the same documents to the stock Pi CLI (`mcp.json`, skills, prompt addendum, model and thinking level, approval patterns) and reloads; Pi upgraded to 1.1.0 for MCP.

## Delivery

1. An editor saves in Operations. The save is one new numbered revision for that agent (stored in Postgres as the operator's *form*: names of enabled library skills and catalog entries plus free text).
2. Operations composes the **document** (`SetupOverride`): library skill contents and enabled catalog entries are resolved from Postgres at that moment.
3. It uploads the document as an `application/json` artifact and sends a **`chat.message`** (the domain allows only `triggerMode: "never"` on a `chat.notice`, so a notice would wait for the agent's 60-second inbox sweep) from `service:operations` to the agent with `triggerMode: "directed"`, idempotency key `setup:<agent>:<revision>` and the labels `setup.kind`, `setup.revision`, `setup.sha256`.
4. The agent validates (`parseOverride`), applies, replies with a `chat.notice` (trigger mode `never`) carrying `setup.ack` and `setup.status` (`applied` or `rejected`, the reason in the text), and reports `setup` in `/profile`. A rejected document leaves the previous setup in place.
5. Operations polls each agent's `/profile` and shows *saved revision N, applied revision M*, and re-sends the latest document when the reported revision is older than the saved one (at most once a minute per agent). A catalog or library edit creates a new revision for every agent that uses the entry, authored by the editor with a note naming the entry.
6. Fleet limits are the same flow with `kind: "limits"` to every agent, from an admin. The document also carries the **global prompt** (`globalPrompt`, at most 16 000 characters): absent keeps the agents' built-in text (`packages/agent-kit/src/setup/global-prompt.ts`, mirrored as `DEFAULT_GLOBAL_PROMPT` in the shared crate and kept equal by a test), an empty text means none. An agent adds it after its role's prompt and before its operator instructions, unless its override says `disableGlobalPrompt: true` (the checkbox on the agent's setup page). The Manager does not apply it: its own prompt names its own tools.
7. **The model** is set at two levels with the same shape: `model` is `{provider?, modelId?, effort?}` (every field optional, at least one present) in an override and in the limits document. Provider, model and effort are three independent settings; a field a layer leaves out is inherited from the layer below: the agent's environment (`PI_PROVIDER`, `PI_MODEL`, optional `PI_EFFORT`), then the fleet's `model`, then the agent's override, and for one job `input.model`. The levels of the effort are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`. Operations checks what it can at save time: the effort is one of the levels (otherwise the request is refused), provider and model id are not blank and at most 80 and 200 characters, and a `model` object has at least one field. Whether the result is allowed on an agent and whether its model takes the effort only the agent knows (its allowlist and its model registry): it rejects the document as a whole with a reason, which Operations shows as the agent's `rejected` reason, and keeps its previous setup. The agent's page shows the effective provider, model and effort and where each comes from (`setup.effective.modelSources`: its environment, the fleet or its own setup); its editor has a select for each of the three with an "inherit" choice that says what it inherits (the fleet's value, else the agent's environment). The fleet limits page has the same three under "Model"; blank there means the agents' environment. Saved revisions and their diffs show the three parts separately (`model.provider`, `model.modelId`, `model.effort`, `limits.model.*`).

The document is the complete desired state; a missed or repeated message does not matter. An empty override (reset) is a revision with no instructions, no model, no patterns, no library skills and no MCP entries.

## Operations server API

All under `/fleet/api/ops`, JSON, behind sign-in. Roles: `viewer` reads, `editor` edits agents, catalog and library, `admin` also edits fleet limits and users. Every write needs the header `X-Operations-Request: 1` and a signed `SameSite=Lax` session cookie.

| Route | What |
| --- | --- |
| `GET /me` | the signed-in user and role |
| `GET /agents` | every agent: id, slug, role, health, saved and applied revision, rejected reason |
| `GET /agents/{slug}` | one agent: the existing setup card, jobs, history and usage readers, the current override form, the role's defaults from `/profile`, the saved and applied revision |
| `PUT /agents/{slug}/setup` | save a revision (`baseRevision` must be the current one, otherwise 409 with the newer revision) |
| `DELETE /agents/{slug}/setup` | reset: a new empty revision |
| `GET /agents/{slug}/revisions`, `POST /agents/{slug}/revisions/{n}/restore` | the revision log with diffs, restore as a new revision |
| `GET/PUT/DELETE /catalog/{name}`, `GET /catalog`, `GET /catalog/{name}/revisions` | MCP catalog |
| `GET/PUT/DELETE /library/{name}`, `GET /library`, `GET /library/{name}/revisions` | skill library |
| `GET/PUT /limits`, `GET /limits/revisions` | fleet limits (admin) |
| `GET/PUT/DELETE /users/{email}` | the allow list (admin) |
| `GET /audit` | who did what, newest first |

Postgres never holds agent secrets or job content. Free text is shown as text, never as markup. MCP entries are checked with the same rules as the agent contract before they are stored.

## Service tokens

A service of the fleet can call the same routes with a bearer token (`OPERATIONS_SERVICE_TOKENS_FILE`, digests only, role viewer or editor). It is the editor role in full, but the only caller today, the Manager, uses it for one thing: saving an agent's operator instructions after the owner confirmed the exact text in Telegram. Every such revision is authored by the service name (`agent/manager`) and is in the audit log; `GET /me` shows `auth: "service"`.

## Manager

The manager is not a kit agent. It has no `/profile` of the kit's shape; it serves its applied `setup` the same way on its own health endpoint so that Operations can poll it. It resolves the model like the kit does, field by field, with the model Pi ran before any setup as the environment layer, and starts Pi with `--model provider/id` and `--thinking <effort>`; Pi clamps a thinking level the model does not take instead of refusing it, so the Manager cannot reject that case. Its `/profile` `model` shows the thinking level Pi reports.
