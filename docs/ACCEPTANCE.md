# SomeWork acceptance matrix

Every normative requirement, acceptance criterion and failure mode of `spec.md`, mapped to the tests that demonstrate
it. Test names are the Rust test functions (`crates/…/tests/<file>.rs`) or Playwright specs (`e2e/tests`).

How to run: `scripts/fetch-tools.sh` once (real `nats-server` and `minio`), then `cargo test --workspace`; the load
profile with `cargo test --release --workspace --test load_control_plane -- --nocapture`; the browser suite with
`SOMEWORK_E2E=1 cargo test --workspace --test ui_e2e` (or `npx playwright test` in `e2e/`).

The result of the last full run is recorded in section 6.

Abbreviations: **dom** = `crates/somework-domain/tests`, **it** = `crates/somework-it/tests`, **api** =
`crates/somework-api/tests`, **core** = unit tests in `somework-core`.

## 1. Functional requirements

| ID | Where it is implemented | Demonstrated by |
|---|---|---|
| CAT-01 self-registered cards default to `draft` | `catalog.rs` `register_agent` | dom/catalog `self_registered_cards_start_as_draft_and_are_invisible_until_approved` |
| CAT-02 search: NL, capability ids, tags, schema compat, side-effect limits, classification, domain/trust, availability | `catalog.rs` `search_catalog` (FTS5 + hard filters) | dom/catalog `natural_language_and_capability_search_find_the_agent_without_its_id`, `hard_constraints_beat_relevance`, `structured_input_compatibility_filters_results` |
| CAT-03 only approved cards are visible | `visible_capabilities` gate used by every read path | dom/catalog `self_registered_cards_start_as_draft_and_are_invisible_until_approved` (capabilities are advertisement only; they gate nothing) |
| CAT-04 hard constraints beat ranking | search pipeline order | dom/catalog `hard_constraints_beat_relevance` |
| CAT-05 logical agent vs runtime instance | `agents` vs `runtime_instances`, `runtimes.rs` | dom/catalog `logical_agents_are_distinct_from_runtime_instances`; dom/ops `runtime_lifecycle_and_presence` |
| ID-01 stable logical identity | agent principal + card independent of processes | dom/catalog `logical_agents_are_distinct_from_runtime_instances` |
| ID-02 distinct `runtimeInstanceId` per process | `register_runtime`, assertion check | dom/catalog (same test; hijack refused); dom/ops `runtime_lifecycle_and_presence` |
| ID-03 sender from credentials | `Domain::authenticate`, `send_message` | dom/messages `sender_identity_comes_from_credentials_not_the_body`; it/gateway_redteam `sender_identity_comes_from_credentials_not_the_body` |
| ID-04 explicit Matrix/OIDC → principal mapping | `human_identities`, `actor_for_oidc`, `principal_for_matrix_user` | dom/security `human_identities_map_explicitly_and_never_by_display_name`; it/matrix_ingest `unmapped_matrix_user_cannot_speak_for_anyone`; it/ui_api `sessions_are_cookie_bound_csrf_protected_and_reflect_the_principal`; e2e 01-login |
| MSG-01 typed `MessageEnvelope` | `messages.rs`, schema validation | core `schema::tests`; dom/messages `notices_and_status_messages_can_never_be_made_triggering` |
| MSG-02 explicit trigger semantics; notices non-triggering | `taxonomy.rs`, `send_message` | core `taxonomy::tests::notices_status_and_streams_never_wake`; dom/messages (same test); it/nats_security `subscription_wake_flags_and_non_triggering_types_never_wake`; it/matrix_resilience `agents_cannot_ping_pong_through_notices_or_forever` |
| MSG-03 stable ids independent of transport | conversation/message ids; `transport_mappings` | it/matrix_inspection `conversation_is_followable_in_a_room_with_canonical_references` |
| MSG-04 duplicate message/idempotency keys | unique indexes + `idempotency_keys` | dom/messages `duplicate_message_ids_and_idempotency_keys_never_create_duplicates`; api/chaos `a_pod_dying_after_commit_but_before_responding_loses_nothing_and_retry_dedupes` |
| ART-01 immutable versioned artifacts | `artifacts.rs`, triggers | dom/messages `an_attached_artifact_is_readable_by_another_principal_of_the_domain`; it/s3_artifacts `*_grants_expire_and_objects_are_immutable` (fs and s3) |
| ART-02 short-lived grants, no permanent creds | presigned URLs | it/s3_artifacts `*_clearance_and_leaked_grants`, `s3_single_upload_never_exposes_the_secret_key` |
| ART-03 attachments verified before send | `verify_message_artifacts` | dom/messages `an_attachment_that_does_not_exist_in_the_domain_is_refused`, `an_upload_that_never_completed_cannot_be_attached`, `an_attachment_above_the_conversations_classification_is_refused`; it/s3_artifacts `*_attached_artifacts_are_verified_and_readable_by_the_receiver` |
| DEL-01 offline agent gets durable directed messages | per-agent inbox consumers | it/nats_resilience `offline_agent_receives_its_durable_inbox_after_reconnect` |
| SUB-01/02 subscriptions with explicit wake | `subscriptions.rs` | dom/messages `event_subscriptions_must_state_wake_behaviour_explicitly`; it/nats_security `subscription_wake_flags_and_non_triggering_types_never_wake` |
| POL-01 policy covers all listed surfaces | `policy.rs`, `enforce` | dom/security, dom/catalog, dom/context_artifacts (disclosure/artifact), dom/tasks (claim/delegation), dom/messages (routing/classification) |
| POL-03 policy decisions recorded with their version | `policy.rs` | dom/ops `policy_versions_are_recorded_with_every_decision`; approvals were removed with tasks (ADR 0003) |
| AUD-01 immutable audit with actor/decision/trace | `audit.rs` hash chain | dom/security `audit_hash_chain_detects_tampering`, `denials_are_recorded_audited_and_projected_as_non_waking_events`; e2e 08-policy-health |
| AUD-02 agent-said vs platform evidence | UI + audit | audit and messages views in the operations UI (needs rework after the cut-over) |
| AUD-03 plaintext vs metadata-only is policy | `audit_plaintext` | dom/messages `audit_views_honour_the_plaintext_policy_choice`; it/matrix_e2ee (metadata-only profile and `audit_plaintext` policy tests) |
| Matrix E2EE profiles (spec "Matrix E2EE profiles", "Advanced Matrix security") | `somework-matrix/src/crypto.rs` (vodozemac Olm/Megolm), `matrix_crypto.rs` + migration 0210 (sealed at rest), `matrix-crypto export/import/verify` CLI | it/matrix_e2ee (11 tests): observer round trip incl. encrypted `!task` execution under policy, encrypted approval reactions, metadata-only profile, Megolm rotation / replay / forgery rejection, recovery-bundle key-loss drill, total key loss, domain backup and restore, pickles sealed at rest, device rotation |
| TEL-01 trace ids survive projections | `traceparent` in events/payloads, spans | it/grpc_flow `traceparent_propagates_into_the_response_and_the_event`; dom/outbox payload assertions |
| TEL-02 metrics | `metrics.rs` | it/nats_streaming `consumer_lag_is_exposed_on_the_metrics_endpoint`; it/s3_artifacts (integrity metric); `/metrics` exposes all spec-listed metric families (`somework_*`) |
| BAK-01 backup/restore with drills | `backup.rs` | it/dr_restore `backup_under_write_load_recreates_everything_acknowledged`, `scheduled_backups_bound_the_data_loss_window`, `restore_fails_clearly_without_the_master_key`, `tampered_backups_are_rejected`, `cli_backup_and_restore_roundtrip` |

## 2. Acceptance criteria

| Area | Criterion | Test |
|---|---|---|
| Discovery | find B by capability / intent | it/rest_smoke `discover_message_and_read_the_answer_over_http`; dom/catalog |
| Policy-filtered discovery | cannot infer hidden entries | dom/catalog `self_registered_cards_start_as_draft_and_are_invisible_until_approved` |
| Durability | accepted task survives loss of a pod | api/chaos `a_pod_dying_after_commit_but_before_responding_loses_nothing_and_retry_dedupes`, `killing_one_replica_under_load_never_loses_an_acknowledged_message`, `a_single_node_restart_after_sigkill_recovers_from_the_wal` |
| Outbox | kill after commit, before publish → eventual delivery | it/nats_crash `killing_the_api_after_commit_but_before_publish_still_delivers_the_message_eventually` |
| Offline delivery | durable inbox after reconnect | it/nats_resilience `offline_agent_receives_its_durable_inbox_after_reconnect` |
| Artifacts | digest-verified before completion | dom/context_artifacts `result_artifacts_must_be_complete_…`; it/s3_artifacts (fs + MinIO incl. `s3_multipart_upload_of_11_mib`) |
| Matrix inspection | humans follow the conversation in a room with canonical references | it/matrix_inspection `conversation_is_followable_in_a_room_with_canonical_references` |
| Loop protection | notice/status/chunk never trigger | dom/messages `notices_and_status_messages_can_never_be_made_triggering`, `agent_to_agent_loops_are_cut_off_by_the_hop_guard`; it/matrix_resilience `agents_cannot_ping_pong_through_notices_or_forever` |
| NATS outage | tasks stay durable, deliver after restore | it/nats_resilience `nats_outage_keeps_accepting_messages_and_delivers_after_restoration` |
| Matrix outage | machine flow continues; timeline catches up | it/matrix_resilience `matrix_outage_does_not_stop_work_and_the_timeline_catches_up_once` |
| MCP | discovery, submit, results without NATS/Matrix creds | it/mcp_stdio `discovery_and_a_message_without_any_transport_credentials`, `handshake_lists_exactly_the_tools_with_schemas` |
| Audit | every privileged mutation → actor, decision, trace | dom/security `denials_are_recorded_audited_…`; every domain test chain-verifies `verify_audit_chain` |
| Recovery | restore recreates outstanding work within RPO/RTO | it/dr_restore (RTO ≈ 0.03 s; RPO ≈ backup interval; asserted) |
| Performance | control-plane write p95 ≤ 250 ms at provisional load | it/load_control_plane (release): task p95 **9.2 ms**, message p95 **8.0 ms** at 20 tasks/s + 100 msg/s; 10× stress p95 **206 ms**, 0 errors |
| Security | red team cannot bypass gateway/policy via Matrix or NATS | it/gateway_redteam (8 tests), it/nats_security `agent_credentials_are_least_privilege`, it/matrix_ingest `replays_echoes_and_forged_deliveries_are_inert`, `token_rotation_and_namespace_confinement` |

## 3. Failure modes

| Failure | Test |
|---|---|
| Domain pod dies before commit / after commit before response | api/chaos `a_pod_dying_after_commit_but_before_responding_…` |
| Dies after commit before NATS publish | it/nats_crash |
| NATS unavailable | it/nats_resilience |
| Matrix unavailable | it/matrix_resilience |
| S3 unavailable | it/s3_artifacts `s3_outage_is_retryable_and_the_message_goes_through_once_the_store_returns` |
| Policy unavailable → fail closed | dom/security `fails_closed_when_the_policy_store_is_unavailable` |
| Matrix event too large | it/matrix_resilience `oversized_projections_are_replaced_by_a_reference` |
| AppService compromised | it/matrix_ingest `token_rotation_and_namespace_confinement` |
| Artifact grant leaked / token replay | it/s3_artifacts, dom/security `single_use_assertions_cannot_be_replayed` |
| Agent status loop | see Loop protection |
| Broker certificate untrusted, for another name, or plaintext when TLS is required | it/sidecar_tls, it/nats_tls_pilot |
| Key lost / rotated | it/sidecar_deploy `the_private_key_is_generated_on_the_agent_host_and_registered_by_public_key_only` |

## 4. Spec test strategy

| Strategy item | Where |
|---|---|
| Contract testing | core `schema::tests` (bundle compiles, unknown fields rejected); every domain test validates envelopes against the bundle at write time |
| Migration | dom/migration_drop_tasks (applies 0001..0500, seeds tasks, messages, artifacts and rules, applies 0600, checks what stays) |
| Integration with real components | PostgreSQL role → real SQLite everywhere; real `nats-server`, real MinIO; Matrix via a protocol-faithful mock (see limitations) |
| Chaos | api/chaos (SIGKILL of real server processes, failpoint `message.send.after_commit`), it/nats_crash |
| Security | dom/security, it/nats_security, it/matrix_ingest |
| Agent-loop | dom/messages, it/matrix_resilience |
| Load | it/load_control_plane |
| Restore | it/dr_restore |
| Browser e2e | e2e/ (Playwright); the specs for tasks, approvals and reconciliation and the console views for them predate the cut-over and need rework |

## 5. Deviations and limitations (honest list)

* **Full trust inside the domain (ADR 0003).** Capabilities are advertisement only and grant nothing; any principal with
  `artifact.read` can read any artifact within its classification clearance. There are no task leases, fencing tokens,
  approvals, delegation grants or reactions; what an agent does after a wake-up is decided by the agent (the TypeScript kit).
* **Wake-ups are not republished.** After JetStream state loss the domain does not re-announce anything; agents sweep their
  unread inbox (`GET /v1/inbox?unread=true`).
* **One public key per agent.** Rotation is a stop / replace / start window with no overlap; `disabled` is the kill switch.
* **The REST listener does not terminate TLS.** HTTPS needs a proxy in front of it (`deploy/vm105`). The sidecar verifies the
  proxy's certificate against a private CA when configured.
* **Deployment artifacts were exercised on one real pilot (2026-10-05)**, before the cut-over, not in CI. See `deploy/README.md`.
* **SQLite instead of PostgreSQL** (requested). Single-writer; replicas are processes on one volume. See `ARCHITECTURE.md`.
* **Matrix homeserver**: Synapse cannot run in this environment (no container daemon). The Matrix plane, including the
  genuine Olm/Megolm E2EE, is tested against a protocol-faithful mock homeserver (`testkit/src/matrix.rs`) and an
  independent vodozemac "Element-like" test device. This validates our use of the documented Client-Server /
  Application Service APIs and the cryptography, not Synapse itself. Not implemented: cross-signing, SAS verification,
  `m.forwarded_room_key`; agent devices do not receive inbound room keys.
* **Federation and A2A are gone** with the gateway crate (they were built on tasks).
* **KMS/HSM**: key custody is a pluggable `MasterKey` seal/open interface backed by a local key file.
* **S3 object bytes** are not part of `somework backup` (bucket versioning/replication is the documented mechanism).
* **Natural-language search** is lexical (FTS5/BM25); the vector ranking hook is documented but not implemented.

## 6. Recorded results (last full validation)

`cargo test --workspace` on 2026-10-10 (macOS arm64, real `nats-server`, real MinIO): **185 passed, 0 failed**. `cargo fmt --check` and
`cargo clippy --workspace --all-targets` are clean.

| Suite | Result |
|---|---|
| Unit tests (`--lib`: core 18, domain 10, api 3, nats, matrix, sidecar and testkit 9) | 40 passed |
| Domain integration (`somework-domain/tests`: catalog 8, events_rules 17, messages 13, ops 6, outbox 6, security 6, migration_drop_tasks 1) | 57 passed |
| Chaos with real server processes (`somework-api/tests/chaos.rs`) | 3 passed |
| Integration (`somework-it`: nats 9, matrix 22, gRPC 10, MCP 10, S3/FS artifacts 17, DR 6, UI API 4, REST 1, events/rules API 1, sidecar 2, load 2, UI e2e gate 1) | 85 passed |
| Control-plane load, debug build | passes its latency targets; release-build figures are not re-measured since the cut-over |
| Browser e2e (Playwright) | not run; needs rework (see section 4) |

## 7. Cut-over (ADR 0003)

Removed from the platform: tasks (state machine, claim/lease/fencing/heartbeat, `/v1/tasks*`, `task.*` message types, task-bound
approvals, delegation grants, capability routing), context packs and handovers, reactions and firings, NATS work stream and pool
consumers, task streaming, the federation gateway and A2A bridge, the sidecar worker runtime, matrix task commands and projections.
`migrations/0600_drop_tasks.sql` drops the tables and columns that no longer have an owner. Attachments (`SendMessage.artifacts[]`) are
verified against stored artifacts; the tests are listed under ART-01..03 above.
