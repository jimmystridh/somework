# Federation gateway and A2A interoperability

Crate `somework-gateway`; wired by `crates/somework-api/src/wiring/gateway.rs` when a `[gateway]` section exists.

```toml
[gateway]
listen = "0.0.0.0:8443"                 # mTLS federation listener (omit to run only the A2A surface)
server_cert_path = "gw-server.pem"      # this gateway's TLS server identity
server_key_path  = "gw-server.key"
client_cert_path = "gw-client.pem"      # identity presented to peers when we call out
client_key_path  = "gw-client.key"
grant_ttl_seconds = 120                 # capped at 300
[gateway.a2a]
enabled = true
public_base_url = "https://somework.example/a2a"   # defaults to the Host the caller used
```

## Trust model (DOM-01..04)

A *domain* is the trust boundary. Nothing crosses it without a registered **peer** (`federation_peers`):

| Layer | What is enforced |
|---|---|
| Transport | mTLS. The listener admits only client certificates whose SHA-256 thumbprint is pinned to an **active** peer (`PinnedClientVerifier`, refreshed every 250 ms and re-checked on every request). |
| Grant | Every request carries a signed `AuthorizationToken` (EdDSA JWS, `typ=somework+grant`) minted by the peer's domain key: audience `somework-gateway:<our domain>`, `confirmation.certificateSha256` equal to the presented certificate, <= 5 minutes, **single use** (`used_jtis`), the required action present, task-bound for task routes. All verification failures return the same `401`. |
| Principal | The peer maps to the local service principal `gateway:<peer>` whose permissions are exactly the peer's export set (capability patterns), classification ceiling (by trust tier unless set), side-effect ceiling, no delegation. The token can only narrow them. |
| Policy | The request is handed to the normal domain core with `Actor.peer_domain = Some(peer)`: catalog visibility, `capability.invoke`, side-effect class, approvals and effective task authority are all decided locally. |
| Disclosure | Independent of the above: outgoing ContextPacks keep only the sections the peer policy allows, only when `security.allowedDomains` names the peer and the classification fits; internal ids, workspace and artifact references are stripped; results have `redactOutputKeys` removed at any depth; failures are reduced to a code; artifacts are only listed with `allowArtifacts`, and bytes are proxied (never an object-store URL). |

A capability that is not exported to the caller and one that does not exist produce the **same** `404` body. Fleet structure is
hidden: federated discovery returns opaque aliases (`export-<hash>`), never agent ids, instance counts or queue depth.

### Least privilege / confused deputy

The remote worker's authority for a federated task is the intersection of its own maximum, the capability's declared side-effect
class, the requester's grant (the `gateway:<peer>` principal, capped by the peer policy) and the task constraint
`sideEffectsAtMost`. A read-only capability therefore never lets the worker exercise write authority on the peer's behalf, and
delegation is impossible because the requester principal cannot delegate.

## Federation protocol (`/federation/v1`)

| Route | Grant action | Purpose |
|---|---|---|
| `POST /catalog/search` | `catalog.read` | exported capabilities (sanitized cards, alias ids) |
| `POST /tasks` | `task.submit`, `capability.invoke`, `context.write` | create a task; body `{capability, input, contextPack?, deadlineAt?, originTaskId}`; idempotent per `originTaskId` |
| `GET /tasks/{id}` | `task.read` (task-bound) | coarse state, redacted result, sanitized failure, disclosed artifacts |
| `GET /tasks/{id}/events` | `task.read` | progress events (JSON or SSE) |
| `POST /tasks/{id}/cancel` | `task.cancel` | cooperative cancellation |
| `GET /tasks/{id}/artifacts/{aid}/{v}` | `artifact.read` | digest-checked bytes proxied through the gateway |

## Egress

A task whose capability is served only by remote agents (catalog entries `remote:<peer>/<alias>` imported with
`POST /v1/admin/federation/peers/{peer}/import-catalog`, or `a2a:<host>/<name>`) stays `submitted` while an outbox row for sink
`gateway` is delivered. The egress runner then:

1. forwards the request (disclosure-filtered ContextPack, fresh grant) — a refusal rejects the local task (`submitted -> rejected`,
   `Domain::reject_task`; code `remote_<code>`), an unreachable peer is a transient error and the outbox retries with backoff, so the
   task stays pending and local work is unaffected;
2. routes the task, claims it as the remote agent's pseudo-worker (lease + fencing token, heartbeats) and mirrors remote progress;
3. on success validates the result against the capability's output schema (`complete_task`), importing artifacts only after the
   remote disclosed them and the bytes hash to the disclosed digest; on failure fails the task with the remote code; if the remote
   becomes unreachable mid-flight the task goes `blocked` and resumes when it returns;
4. records the mapping in `federated_tasks` (`internal_task_id`, `external_task_id`, `external_context_id`,
   `remote_agent_card_digest`, `remote_interface`, `remote_principal`, `protocol_version`) and resumes open mappings after a restart.

## A2A (v1, HTTP+JSON binding)

Mounted at `/a2a` (and per-agent at `/a2a/agents/{alias}`); card at `/.well-known/agent-card.json`.

* **Card** — public card lists skills of `public` catalog entries (exported capabilities only); the authenticated
  `GET /a2a/extendedAgentCard` lists what the caller may invoke. Advertises `HTTP+JSON`/`1.0`, streaming, bearer auth, and a
  `urn:somework:a2a:skill-schemas:v1` extension carrying input/output JSON Schemas and side-effect classes.
* **Operations** — `POST /message:send` (blocking up to 25 s unless `returnImmediately`), `POST /message:stream` (SSE of
  `task`/`statusUpdate`/`artifactUpdate`), `GET /tasks/{id}`, `GET /tasks`, `POST /tasks/{id}:cancel`, `…:subscribe`. Push
  notification configs answer `PUSH_NOTIFICATION_NOT_SUPPORTED` (capability advertised as false). `A2A-Version` other than `1.0`
  answers `VERSION_NOT_SUPPORTED`. Errors use the `{"error": {code, status, message, details:[ErrorInfo{reason}]}}` envelope the
  official SDKs parse.
* **Mapping** — `contextId` = Conversation id; skill = capability (`message.metadata.skillId` or a `skillId`/`capability` key in a data
  part, `input` = rest of the data part); states map `submitted|queued -> SUBMITTED`, `claimed|running|blocked -> WORKING`,
  `succeeded -> COMPLETED`, etc.; result -> artifact with a `data` part; platform artifacts -> file parts behind
  `/a2a/artifacts/{task}/{artifact}/{version}` (authenticated, digest-checked).
* **Immutability** — a message addressed to a terminal task creates a *sibling* task in the same conversation; the lineage is
  recorded in `federated_tasks.follow_up_of`.
* **Authorization** — callers are ordinary service principals (create with `POST /v1/admin/federation/a2a/clients`, which returns a
  key; tokens are workload assertions). Their actor is tagged `peer_domain = "a2a"`, so catalog visibility is exported-only and
  every request goes through domain policy. Hidden skills are indistinguishable from unknown ones.
* **Import (CAT-06)** — `POST /v1/admin/federation/a2a/import {url|card, approve}` normalizes an external card into a catalog entry
  (`source.type = a2a`, digest of the card, `draft` unless `approve`). Capability ids are namespaced `a2a.<host>-<name>.<skill>`;
  without our schema extension skills are registered conservatively (`write`, open schemas). Cards without an HTTP+JSON interface are
  refused. Outbound credentials per origin (static bearer or a signing key minting assertions) are sealed in `a2a_credentials`.

## Operating

```
POST /v1/admin/federation/peers                 add a peer (cert thumbprints, server CA, signing keys, policy)
PUT  /v1/admin/federation/peers/{p}/policy      exports / imports / ceilings / disclosure
POST /v1/admin/federation/peers/{p}/keys        rotate verification keys (old grants stop verifying immediately)
POST /v1/admin/federation/peers/{p}/revoke      immediate; revoked peers cannot be modified (re-add with new credentials)
GET  /v1/admin/federation/identity              our audience, client-certificate thumbprint and signing keys (to give to the peer)
```

Known limits: one ContextPack per federated request; interactive `input_required` is not forwarded (the local task fails with
`remote_input_required`); A2A push notifications and the JSON-RPC/gRPC bindings are not implemented; A2A files without a digest are
pinned by the digest of what was received rather than verified against a disclosed one.
