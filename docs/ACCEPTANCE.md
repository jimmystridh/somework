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
| CAT-03 policy filtering before results | `visible_capabilities` gate used by every read path | dom/catalog `policy_filtering_happens_before_results_so_hidden_capabilities_are_not_leaked`; dom/tasks `hidden_capabilities_look_nonexistent_to_unauthorized_callers`; it/gateway_security `unexported_and_nonexistent_capabilities_are_indistinguishable` |
| CAT-04 hard constraints beat ranking | search pipeline order | dom/catalog `hard_constraints_beat_relevance` |
| CAT-05 logical agent vs runtime instance | `agents` vs `runtime_instances`, `runtimes.rs` | dom/catalog `logical_agents_are_distinct_from_runtime_instances`; dom/ops `runtime_lifecycle_and_presence` |
| CAT-06 import external A2A cards | `somework-gateway` `a2a/importer` | it/a2a_egress `imported_a2a_agent_is_invoked_through_the_a2a_client`, `cards_without_an_http_json_interface_are_refused` |
| ID-01 stable logical identity | agent principal + card independent of processes | dom/catalog `logical_agents_are_distinct_from_runtime_instances`; api/chaos `a_worker_lost_with_its_lease_is_recovered_by_a_different_replica` |
| ID-02 distinct `runtimeInstanceId` per process | `register_runtime`, assertion check | dom/catalog (same test; hijack refused); dom/ops `runtime_lifecycle_and_presence` |
| ID-03 sender from credentials | `Domain::authenticate`, `send_message` | dom/messages `sender_identity_comes_from_credentials_not_the_body`; it/gateway_redteam `sender_identity_comes_from_credentials_never_from_the_payload` |
| ID-04 explicit Matrix/OIDC → principal mapping | `human_identities`, `actor_for_oidc`, `principal_for_matrix_user` | dom/security `human_identities_map_explicitly_and_never_by_display_name`; it/matrix_ingest `unmapped_matrix_user_cannot_submit_tasks`; it/ui_api `sessions_are_cookie_bound_csrf_protected_and_reflect_the_principal`; e2e 01-login |
| DOM-01 every object belongs to a domain | `domain_id` on every table | schema (`migrations/0001_core.sql`); dom/context_artifacts `clearance_and_allowed_domains_gate_context_disclosure` |
| DOM-02 cross-domain default deny | peer filter + exports | it/gateway_federation `exported_capability_is_invoked_across_domains_without_exposing_the_fleet`; it/gateway_security `unexported_and_nonexistent_capabilities_are_indistinguishable` |
| DOM-03 cross-domain only through gateways | gateway is the only cross-domain path | it/gateway_redteam `matrix_and_nats_style_inputs_cannot_create_executable_work` |
| DOM-04 independent disclosure/execution evaluation | `disclosure.rs`, ingress policy | it/gateway_security `output_is_redacted_before_it_leaves_the_domain`, `a_remote_caller_of_a_read_only_capability_cannot_borrow_the_workers_write_authority` |
| MSG-01 typed `MessageEnvelope` | `messages.rs`, schema validation | core `schema::tests`; dom/messages `notices_and_status_messages_can_never_be_made_triggering` |
| MSG-02 explicit trigger semantics; notices non-triggering | `taxonomy.rs`, `send_message` | core `taxonomy::tests::notices_status_and_streams_never_wake`; dom/messages (same test); it/nats_security `subscription_wake_flags_and_non_triggering_types_never_wake`; it/matrix_resilience `agents_cannot_ping_pong_through_notices_or_forever` |
| MSG-03 stable ids independent of transport | conversation/message ids; `transport_mappings` | it/matrix_inspection `task_is_followable_in_a_room_thread_with_structured_events` |
| MSG-04 duplicate message/idempotency keys | unique indexes + `idempotency_keys` | dom/messages `duplicate_message_ids_and_idempotency_keys_never_create_duplicates`; dom/tasks `idempotent_submit_returns_the_same_task_and_conflicts_on_different_payload` |
| TASK-01 task + outbox atomic | `submit_task` single tx + `emit` | dom/outbox `task_creation_atomically_persists_task_event_and_outbox_rows`, `failed_transactions_leave_no_outbox_rows` |
| TASK-02 leases, revision checks, fencing | `tasks/worker.rs` | dom/tasks `racing_claims_produce_exactly_one_lease_owner`, `expired_lease_requeues_and_fencing_blocks_the_old_worker`, `stale_expected_revision_is_rejected`; dom/model (property test) |
| TASK-03 output schema on completion | `complete_task` | it/rest_smoke; it/sidecar_worker `results_violating_the_output_schema_become_invalid_result_failures`; dom/tasks `happy_path_submit_claim_progress_complete` |
| TASK-04 terminal states immutable | FSM + SQL trigger | core `fsm::tests::terminal_states_reject_every_event`, `fsm::property_tests`; dom/tasks `terminal_tasks_are_immutable_even_at_the_database_level`; dom/model |
| TASK-05 crashed worker's task re-queued | reaper | dom/tasks `expired_lease_requeues_and_fencing_blocks_the_old_worker`; it/sidecar_worker `killing_the_sidecar_mid_task_lets_another_runtime_finish_retry_safe_work`; api/chaos `a_worker_lost_with_its_lease_is_recovered_by_a_different_replica` |
| TASK-06 irreversible work never auto-retried | reconciliation state | dom/tasks `irreversible_tasks_are_never_auto_retried_they_wait_for_reconciliation`, `idempotent_irreversible_actions_may_be_retried`; dom/ops `reconciliation_can_retry_or_cancel`; it/sidecar_worker `irreversible_work_is_parked_for_reconciliation_not_retried`; e2e 06-reconcile |
| TASK-07 cancellation is a request; races | `cancel_task`, FSM | dom/tasks `cancellation_is_immediate_before_claim_and_cooperative_after`, `cancellation_race_can_legitimately_resolve_to_completed`; it/sidecar_worker `cooperative_cancellation_is_acknowledged_by_the_sidecar` |
| CTX-01 typed ContextPack | `context.rs`, schema | dom/context_artifacts `context_packs_are_immutable_versioned_and_digest_checked`; core `schema::tests::sample_context_pack_from_the_spec_is_valid` |
| CTX-02 facts/hypotheses/decisions/open questions separated | schema sections | core schema test; dom/context_artifacts `receiver_sees_a_manifest_first_and_only_the_disclosed_sections` |
| CTX-03 large evidence by reference | inline limit + artifact refs | dom/context_artifacts `oversized_packs_must_reference_artifacts_instead_of_embedding` |
| CTX-04 ownership transfer needs acceptance | `transfer_ownership_tx` | dom/context_artifacts `ownership_transfer_requires_acceptance_and_moves_the_fence_atomically`, `transfer_fails_if_the_offerer_lost_the_task_in_the_meantime` |
| CTX-05 imported context is data | `instructionsTrusted: false` const | dom/context_artifacts (schema violation when `true`); it/gateway_redteam `context_pack_text_never_changes_authority` |
| ART-01 immutable versioned artifacts | `artifacts.rs`, triggers | dom/context_artifacts `artifacts_are_digest_verified_before_use`; it/s3_artifacts `*_grants_expire_and_objects_are_immutable` (fs and s3) |
| ART-02 short-lived grants, no permanent creds | presigned URLs | it/s3_artifacts `*_confused_deputy_and_leaked_grants`, `s3_single_upload_never_exposes_the_secret_key`; dom/context_artifacts `download_grants_respect_clearance_and_task_authority` |
| ART-03 verified before final output | `verify_result_artifacts` | dom/context_artifacts `result_artifacts_must_be_complete_before_a_task_can_succeed`; it/s3_artifacts `*_required_artifacts_gate_completion` |
| STR-01 chunks via Core NATS, checkpoints durable | `somework-nats` StreamSource | it/nats_streaming `live_chunks_stream_over_core_nats_and_late_consumers_recover_from_the_snapshot` |
| STR-02 recover state after missed chunks | SSE snapshot-first | same test |
| DEL-01 offline agent gets durable directed messages | per-agent inbox consumers | it/nats_resilience `offline_agent_receives_its_durable_inbox_after_reconnect` |
| DEL-02 at-least-once + deduped transitions | `Nats-Msg-Id`, claim idempotency | it/nats_dispatch `duplicate_jetstream_delivery_changes_nothing_and_msg_id_dedupes_republish`, `transient_claim_error_does_not_ack_and_the_notification_is_redelivered` |
| SUB-01/02 subscriptions with explicit wake | `subscriptions.rs` | dom/messages `event_subscriptions_must_state_wake_behaviour_explicitly`; it/nats_security `subscription_wake_flags_and_non_triggering_types_never_wake` |
| POL-01 policy covers all listed surfaces | `policy.rs`, `enforce` | dom/security, dom/catalog, dom/context_artifacts (disclosure/artifact), dom/tasks (claim/delegation), dom/messages (routing/classification) |
| POL-02 side-effect class as input | `AuthzRequest.side_effects` | core/policy unit tests; dom/tasks `confused_deputy_read_only_task_cannot_delegate_write_work` |
| POL-03 approvals bound to digest+revision+expiry | `approvals` | dom/security `approvals_are_bound_to_digest_revision_expiry_and_a_different_person`, `requesters_cannot_approve_their_own_irreversible_actions`; it/matrix_approval; e2e 05-approvals |
| AUD-01 immutable audit with actor/decision/trace | `audit.rs` hash chain | dom/security `audit_hash_chain_detects_tampering`, `denials_are_recorded_audited_and_projected_as_non_waking_events`; e2e 08-policy-health |
| AUD-02 agent-said vs platform evidence | UI + `task_events`/audit | e2e 04-evidence (messages vs evidence tabs, canonical JSON) |
| AUD-03 plaintext vs metadata-only is policy | `audit_plaintext` | dom/messages `audit_views_honour_the_plaintext_policy_choice`; it/matrix_e2ee (metadata-only profile and `audit_plaintext` policy tests) |
| Matrix E2EE profiles (spec "Matrix E2EE profiles", "Advanced Matrix security") | `somework-matrix/src/crypto.rs` (vodozemac Olm/Megolm), `matrix_crypto.rs` + migration 0210 (sealed at rest), `matrix-crypto export/import/verify` CLI | it/matrix_e2ee (11 tests): observer round trip incl. encrypted `!task` execution under policy, encrypted approval reactions, metadata-only profile, Megolm rotation / replay / forgery rejection, recovery-bundle key-loss drill, total key loss, domain backup and restore, pickles sealed at rest, device rotation |
| TEL-01 trace ids survive projections | `traceparent` in events/payloads, spans | it/grpc_flow `traceparent_propagates_into_task_events`; dom/outbox payload assertions |
| TEL-02 metrics | `metrics.rs` | it/nats_streaming `consumer_lag_is_exposed_on_the_metrics_endpoint`; it/s3_artifacts (integrity metric); `/metrics` exposes all spec-listed metric families (`somework_*`) |
| BAK-01 backup/restore with drills | `backup.rs` | it/dr_restore `backup_under_write_load_recreates_outstanding_work`, `scheduled_backups_bound_the_data_loss_window`, `restore_fails_clearly_without_the_master_key`, `tampered_backups_are_rejected`, `cli_backup_and_restore_roundtrip` |
| BAK-02 JetStream recoverable from canonical state | `republish_queued_tasks` | it/nats_resilience `jetstream_state_loss_is_repaired_by_republishing_canonical_queued_tasks`; dom/outbox `lost_stream_state_is_rebuilt_from_canonical_queued_tasks`; it/dr_restore `outbox_rows_survive_restore_and_lost_broker_state_is_republished` |

## 2. Acceptance criteria

| Area | Criterion | Test |
|---|---|---|
| Discovery | find B by capability / intent | it/rest_smoke `discover_submit_claim_complete_over_http`; dom/catalog |
| Policy-filtered discovery | cannot infer hidden entries | dom/catalog `policy_filtering_happens_before_results_so_hidden_capabilities_are_not_leaked` |
| No inbound agents | outbound-only worker completes work | it/nats_dispatch `outbound_only_worker_receives_work_over_nats_and_completes_it`; it/sidecar_worker `polling_worker_runs_tasks_end_to_end_with_throttled_progress` |
| Durability | accepted task survives loss of a pod | api/chaos `a_pod_dying_after_commit_but_before_responding_loses_nothing_and_retry_dedupes`, `killing_one_replica_under_load_never_loses_an_acknowledged_task`, `a_single_node_restart_after_sigkill_recovers_from_the_wal` |
| Outbox | kill after commit, before publish → eventual delivery | it/nats_crash `killing_the_api_after_commit_but_before_publish_still_delivers_eventually` |
| Offline delivery | durable inbox after reconnect | it/nats_resilience `offline_agent_receives_its_durable_inbox_after_reconnect` |
| Claim safety | two racers → one owner | dom/tasks `racing_claims_produce_exactly_one_lease_owner`; it/nats_dispatch `racing_workers_produce_exactly_one_canonical_lease_and_both_ack` |
| Fencing | expired fence cannot write | dom/tasks `expired_lease_requeues_and_fencing_blocks_the_old_worker`; it/sidecar_worker `a_paused_worker_that_resumes_after_losing_its_lease_has_its_result_discarded` |
| Duplicate safety | repeated HTTP and JetStream delivery | dom/tasks `idempotent_submit_…`; it/nats_dispatch `duplicate_jetstream_delivery_changes_nothing_…` |
| Context | transfer + selective evidence | dom/context_artifacts `receiver_sees_a_manifest_first_and_only_the_disclosed_sections` |
| Ownership transfer | sender owns until atomic accept | dom/context_artifacts `ownership_transfer_requires_acceptance_and_moves_the_fence_atomically` |
| Artifacts | digest-verified before completion | dom/context_artifacts `result_artifacts_must_be_complete_…`; it/s3_artifacts (fs + MinIO incl. `s3_multipart_upload_of_11_mib`) |
| Matrix inspection | humans follow request/progress/input/completion in a room/thread | it/matrix_inspection `task_is_followable_in_a_room_thread_with_structured_events`, `progress_updates_are_throttled_into_edits_of_one_notice` |
| Structured inspection | UI shows exact canonical envelope/task/pack | e2e 04-evidence |
| Loop protection | notice/status/chunk never trigger | dom/messages `notices_and_status_messages_can_never_be_made_triggering`, `agent_to_agent_loops_are_cut_off_by_the_hop_guard`; it/matrix_resilience `agents_cannot_ping_pong_through_notices_or_forever` |
| NATS outage | tasks stay durable, deliver after restore | it/nats_resilience `nats_outage_keeps_accepting_tasks_and_delivers_after_restoration` |
| Matrix outage | machine flow continues; timeline catches up | it/matrix_resilience `matrix_outage_does_not_stop_work_and_the_timeline_catches_up_once` |
| Cross-domain allow | exported capability invoked, fleet hidden | it/gateway_federation |
| Cross-domain deny | unauthorized stays undiscoverable/inaccessible | it/gateway_security `unexported_and_nonexistent_capabilities_are_indistinguishable`, `unpinned_certificates_cannot_even_complete_the_tls_handshake`, `revoking_a_peer_cuts_access_immediately_and_rotation_retires_old_grants` |
| Least privilege | read-only caller cannot use assignee's write rights | dom/tasks `confused_deputy_read_only_task_cannot_delegate_write_work`; it/gateway_security `a_remote_caller_of_a_read_only_capability_cannot_borrow_the_workers_write_authority`; it/s3_artifacts `*_confused_deputy_and_leaked_grants` |
| A2A | external conforming client discovers, starts, gets result/artifact | it/a2a_interop `official_sdk_discovers_runs_and_streams` (official Python `a2a-sdk`); it/a2a_gateway |
| MCP | discovery, submit, results without NATS/Matrix creds | it/mcp_stdio `discovery_submit_result_without_any_transport_credentials`, `handshake_lists_exactly_the_spec_tools_with_schemas` |
| Audit | every privileged mutation → actor, decision, trace | dom/security `denials_are_recorded_audited_…`; every domain test chain-verifies `verify_audit_chain` |
| Recovery | restore recreates outstanding work within RPO/RTO | it/dr_restore (RTO ≈ 0.03 s; RPO ≈ backup interval; asserted) |
| Performance | control-plane write p95 ≤ 250 ms at provisional load | it/load_control_plane (release): task p95 **9.2 ms**, message p95 **8.0 ms** at 20 tasks/s + 100 msg/s; 10× stress p95 **206 ms**, 0 errors |
| Dispatch | queued→worker-notification p95 ≤ 1 s | it/nats_dispatch `dispatch_latency_p95_stays_under_one_second_for_200_tasks` |
| Security | red team cannot bypass gateway/policy via Matrix or NATS | it/gateway_redteam (8 tests), it/nats_security `agent_credentials_are_least_privilege`, it/matrix_ingest `replays_echoes_and_forged_deliveries_are_inert`, `token_rotation_and_namespace_confinement` |

## 3. Failure modes

| Failure | Test |
|---|---|
| Domain pod dies before commit / after commit before response | api/chaos `a_pod_dying_after_commit_but_before_responding_…` |
| Dies after commit before NATS publish | it/nats_crash |
| NATS unavailable | it/nats_resilience |
| Matrix unavailable | it/matrix_resilience |
| S3 unavailable | it/s3_artifacts `s3_outage_keeps_the_task_running_until_the_store_returns` |
| Policy unavailable → fail closed | dom/security `fails_closed_when_the_policy_store_is_unavailable` |
| Duplicate JetStream delivery / lost cursor | it/nats_dispatch |
| Worker dies after claim; stale worker resumes | dom/tasks, it/sidecar_worker |
| Worker dies in an irreversible action | dom/tasks, it/sidecar_worker |
| Cancellation races completion | dom/tasks `cancellation_race_can_legitimately_resolve_to_completed` |
| Out-of-order progress | dom/model (revision/sequence monotonic) |
| Matrix event too large | it/matrix_resilience `oversized_projections_are_replaced_by_a_reference` |
| AppService compromised | it/matrix_ingest `token_rotation_and_namespace_confinement` |
| Gateway unavailable / remote rejects / compromised | it/gateway_security `an_unreachable_gateway_leaves_the_task_pending_…`, `remote_refusal_rejects_the_local_task`, `revoking_a_peer_…` |
| Artifact grant leaked / token replay | it/s3_artifacts, it/gateway_security `grants_are_single_use_certificate_bound_and_short_lived`, dom/security `single_use_assertions_cannot_be_replayed` |
| Agent status loop | see Loop protection |
| Work notification lost / purged / consumer deleted; NATS down before, during or after; worker started while the broker is down | it/nats_wake_resilience (HTTP sweep and fallback; each task runs exactly once) |
| Broker certificate untrusted, for another name, or plaintext when TLS is required | it/sidecar_tls, it/nats_tls_pilot |
| Domain and worker over a TLS-only broker | it/nats_tls_pilot `domain_and_worker_exchange_wakes_over_a_tls_only_broker` |
| Worker receives SIGTERM (`docker stop`) | it/sidecar_deploy `sigterm_stops_the_worker_gracefully_and_ends_its_runtime` |
| Executor tries to read the sidecar's environment | sidecar `worker::adapter::tests`, it/sidecar_deploy `executors_do_not_inherit_the_sidecars_environment` (file access to the key is not prevented: see section 5) |
| Pi agent killed mid-run (`kill -9`, repeated) / SIGTERM with a long tool in flight | pi-agent `test/crash.test.ts` (separate processes), and the same drills on VM102 containers (`adapters/pi/deploy/README.md`) |
| Pi run finished but its outcome was lost before commit | pi-agent `test/service.test.ts`: retry re-attaches, one commit, one pull request |
| Tool call cancelled / sandbox command must die with its caller | pi-agent `test/sandbox.test.ts` (process tree killed), `test/runtime.test.ts` (abort promptly) |
| Sandbox tries to reach credentials, other hosts, private ranges or metadata | `adapters/pi/deploy/verify-sandbox.sh` (13 checks, run on VM102), `test/egress.test.ts` |
| Requester input mid-run / artifact upload from a worker | sdk `test/worker.test.ts` |
| Key lost / rotated | it/sidecar_deploy `the_private_key_is_generated_on_the_worker_host_and_registered_by_public_key_only` |

## 4. Spec test strategy

| Strategy item | Where |
|---|---|
| Contract testing | core `schema::tests` (bundle compiles, sample ContextPack, unknown fields rejected); every domain test validates envelopes against the bundle at write time |
| State-machine / property testing | core `fsm::property_tests`; dom/model (two proptests over random op sequences incl. stale fences, expiries, cancels) |
| Integration with real components | PostgreSQL role → real SQLite everywhere; real `nats-server`, real MinIO; Matrix via a protocol-faithful mock (see limitations) |
| Chaos | api/chaos (SIGKILL of real server processes), it/nats_crash |
| Security | dom/security, it/gateway_redteam, it/gateway_security, it/nats_security, it/matrix_ingest |
| Agent-loop | dom/messages, it/matrix_resilience |
| Interop | it/a2a_interop (official SDK) |
| Load | it/load_control_plane |
| Restore | it/dr_restore |
| Browser e2e | e2e/ (Playwright, 32 specs) |

## 5. Deviations and limitations (honest list)

* **Executors can read the worker's key.** `--exec` children run as the sidecar's user on its filesystem. The sidecar strips
  their environment, which does not stop file or `/proc` access. Only trusted, allowlisted executors are acceptable until
  stronger isolation (separate container/user, key unreachable) exists. See `deploy/README.md`.
* **Pi agent (`adapters/pi`)**: Pi Durable is experimental (pinned exactly; SQLite storage uses Node's experimental `node:sqlite`).
  The model credential lives in the harness process. Pull request creation is tested only against a stand-in GitHub server (no
  repository token yet). Metrics scraping, alerts and the dashboard are written but not loaded into the central monitoring stack.
  HTTP long-poll only (no NATS wake in the TypeScript SDK).
* **One public key per agent.** Rotation is a stop / replace / start window with no overlap; `disabled` is the kill switch.
* **The REST listener does not terminate TLS.** HTTPS needs a proxy in front of it (`deploy/vm105`). The sidecar verifies the
  proxy's certificate against a private CA when configured.
* **Deployment artifacts were exercised on one real pilot (2026-10-05)**, not in CI: images, compose stacks, TLS proxy, broker
  outage, SIGTERM, rotation and backup/restore. The exercise found four bugs in the first draft of the artifacts (all fixed).
  See `deploy/README.md`.
* **Chunk streaming needs NATS at worker start.** If the worker begins over HTTP because the broker was down, work and
  results flow normally but live chunk streaming is not set up until the next restart.
* **SQLite instead of PostgreSQL** (requested). Single-writer; replicas are processes on one volume. See `ARCHITECTURE.md`.
* **Matrix homeserver**: Synapse cannot run in this environment (no container daemon). The Matrix plane — including the
  genuine Olm/Megolm E2EE — is tested against a protocol-faithful mock homeserver (`testkit/src/matrix.rs`) and an
  independent vodozemac "Element-like" test device. This validates our use of the documented Client-Server /
  Application Service APIs and the cryptography, not Synapse itself. Not implemented: cross-signing, SAS verification,
  `m.forwarded_room_key`; agent devices do not receive inbound room keys.
* **Federation gateway** implements the HTTP+JSON A2A binding only (not JSON-RPC/gRPC bindings or push notifications);
  one ContextPack per federated request; a remote `input_required` is surfaced as a local failure.
* **KMS/HSM**: key custody is a pluggable `MasterKey` seal/open interface backed by a local key file.
* **S3 object bytes** are not part of `somework backup` (bucket versioning/replication is the documented mechanism).
* **Natural-language search** is lexical (FTS5/BM25); the vector ranking hook is documented but not implemented.

## 6. Recorded results (last full validation)

Run with `cargo test --workspace` target by target on 2026-10-04 (macOS arm64, real `nats-server` 2.15, real MinIO,
official Python `a2a-sdk`, headless Chromium):

| Suite | Result |
|---|---|
| Unit tests (`--lib`, all crates) | 65 passed |
| Domain integration (`somework-domain/tests`: tasks 16, catalog 8, messages 9, context/artifacts 9, security 10, ops 9, outbox 8, model-based property tests 2) | 71 passed |
| Chaos with real server processes (`somework-api/tests/chaos.rs`) | 4 passed |
| Integration/e2e (`somework-it`: nats 14, matrix 27, gateway/A2A 23, gRPC 15, sidecar/MCP/extended tools 23, S3/FS artifacts 17, DR 6, UI API 4, REST 1, NATS wake resilience 5, NATS TLS pilot 3, sidecar TLS 3, sidecar deployment 3) | 145 passed |
| Control-plane load (release): 20 tasks/s + 100 msg/s | task p95 9.2 ms, message p95 8.0 ms, 0 errors (target ≤ 250 ms), measured on a quiet machine before the pilot changes. **Not re-validated afterwards:** re-runs on a machine with load average 21–34 gave task p95 between 7 ms and 800 ms (the 250 ms target passed in some runs, failed in others); no domain hot-path code changed, but a quiet-machine re-run is still owed |
| 10× stress: 200 tasks/s + 1000 msg/s | task p95 206 ms, 0 errors on the quiet machine; fails its 2 s target intermittently under the same background load (0 errors, latency only). Same re-run owed. In a debug build this profile is expected to fail: run it with `--release` |
| Browser e2e (Playwright, Chromium, fresh seeded devstack) | 32 passed (last run before the pilot changes; not re-run since) |
| `cargo clippy --workspace --all-targets` | clean |
| TypeScript SDK (`sdk/typescript`, real domain) | 21 passed |
| Pi agent (`adapters/pi`: sandbox, runtime, git, units, egress, service, crash matrix) | 55 passed |
