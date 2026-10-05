# SomeWork operations guide

How to run, back up, restore and reason about a SomeWork trust domain. The spec's PostgreSQL control plane is
**SQLite** here; this document states what that changes and what it does not.

## 1. Database operating model (SQLite)

* One domain = one SQLite file (`domain.db`) in WAL mode plus its `-wal`/`-shm` side files. Writers use
  `BEGIN IMMEDIATE`, so concurrent `claim`s, ownership transfers and outbox claims serialize on SQLite's write lock
  with a 15 s busy timeout. This is what gives "two workers racing for one task produce exactly one lease owner".
* "Stateless Domain Service replicas" means **several processes on the same host sharing one volume** (rolling
  restarts, a separate outbox/maintenance process). It does **not** mean replicas on different hosts: SQLite needs
  working POSIX locking and shared memory for the WAL index.
* Never put the database on NFS/SMB/EFS or any network filesystem. Use a local SSD or a block volume that is attached
  to exactly one host at a time. A multi-AZ deployment is therefore *active/standby with volume failover or
  replication*, not active/active.
* `synchronous = FULL` (default) fsyncs every commit: an acknowledged write survives a process or OS crash.
  `domain.synchronous_full = false` (WAL + NORMAL) survives process crashes but may lose the last commits on power
  loss; use it for development only.
* Throughput budget from the spec (<= 100 messages/s, <= 20 task submissions/s) is well inside what one writer
  sustains; the load tests exercise it.

## 2. Backups (BAK-01)

`somework backup --config somework.toml --to /backups/backup-2026...` or the scheduled form:

```toml
[domain]
backup_interval_seconds = 300        # 0 disables
backup_dir = "/backups"
backup_keep = 12
backup_include_master_key = false    # keep the key out of the backup volume in production
```

A backup is a directory:

| File | Purpose |
|---|---|
| `somework.db` | `VACUUM INTO` snapshot: transactionally consistent while writers keep running, defragmented, `integrity_check`ed |
| `objects/**` | filesystem artifact store (hard-linked: objects are immutable; copied across filesystems) |
| `somework.masterkey` | only with `include_master_key`; **key material must be stored separately from the data in production** |
| `manifest.json` | domain id, schema version, audit chain head, outstanding task counts, SHA-256 + size of every file |

The DB snapshot is taken first and objects after it, so every artifact referenced by the snapshot exists in the
backup (extra objects are harmless). Scheduled backups are written to `.backup-*.partial` and renamed, so the backup
directory only ever contains complete backups; the oldest beyond `backup_keep` are removed.

JetStream and Matrix are deliberately **not** backed up (BAK-02): accepted work, the outbox and the event history are
in the database. After a restore, run `somework admin republish-queued` (or let the NATS plane do it on start) and
every queued task is announced again; duplicate notifications are harmless because claims are idempotent.

### Meeting RPO <= 5 minutes

Snapshot backups bound the data-loss window to the backup interval. For continuous replication use
[Litestream](https://litestream.io) next to the process: it streams WAL frames to S3/MinIO (or another replica
volume) with seconds of lag and supports point-in-time restore. Restore the replicated database file, then place the
master key and the object store, and start the server. Litestream and the snapshot backups are complementary:
Litestream for RPO, snapshots for verified, self-describing restore points (manifest, audit head, object copies).

Provisional targets (spec): RPO <= 5 min, RTO <= 60 min, 99.9 % control-plane availability. Measured in the DR drill
(`crates/somework-it/tests/dr_restore.rs`, test dataset, Apple silicon laptop): restore + verify + serving in well
under a second, observed data-loss window about one backup interval (1.0 s measured with a 2 s interval).

## 3. Restore runbook (BAK-01 drill)

1. Provision a clean host/volume. Install the same or newer `somework` binary (migrations are forward-only).
2. Obtain the master key from the secret manager (`SOMEWORK_MASTER_KEY`, base64url 32 bytes) unless the backup
   carries `somework.masterkey`.
3. `somework restore --from /backups/backup-... --to /var/lib/somework`
   * verifies every file against `manifest.json` (tampering, truncation or a missing object abort the restore),
   * refuses to restore into a directory that already holds a database,
   * opens the restored database (this fails with *"the restored database could not be opened"* if the key is wrong,
     and with *"does not contain the master key"* if none was supplied; a new key is never invented),
   * verifies the audit hash chain, compares the queued-task count with the manifest and re-hashes a sample of
     artifact objects,
   * writes `somework.toml` next to the data.
4. For an S3 artifact store, point `[objects.s3]` at the bucket (bytes are not part of the backup, see section 4).
5. `somework serve --config /var/lib/somework/somework.toml`.
6. Re-announce queued work: `somework admin republish-queued` if the broker was lost. Tasks whose lease expired
   while the domain was down are re-queued automatically by the maintenance loop (irreversible actions go to
   reconciliation, never to a blind retry).
7. Smoke test: `GET /readyz`, `GET /v1/admin/audit/verify`, claim a queued task, fetch a ContextPack and an artifact.

A DR test only counts when an outstanding task submitted before the backup becomes claimable and its ContextPack and
artifacts stay authorized and verifiable. `dr_restore.rs` proves exactly that, plus idempotency keys, fencing tokens
that keep increasing, pending approvals that remain decidable and outbox rows that re-publish.

## 4. Artifact storage

Two `ObjectStore` implementations behind one trait:

* **fs**: `objects.kind = "fs"`. Presigned PUT/GET URLs are HMAC-signed grants served by the API process itself.
  Suitable for single-node installs; backed up with the database.
* **s3**: `objects.kind = "s3"` with `[objects.s3] endpoint/region/bucket/access_key/secret_key/path_style`. Works with
  AWS S3 and MinIO. SigV4 is implemented in the service (no SDK): query-presigned PUT/GET/UploadPart URLs for agents,
  header-signed calls for the domain's own HEAD/GET/multipart control. The access key and secret never appear in any
  response; agents get URLs that expire after `upload_grant_ttl_seconds` / `download_grant_ttl_seconds` (default 900 s
  / 120 s). Uploads above `multipart_threshold_bytes` use S3 multipart with presigned part URLs; the single PUT carries
  a signed `If-None-Match: *` so a committed version cannot be overwritten.
* Integrity is verified **by the domain**, not trusted from storage: `complete` streams the stored object, compares
  size and SHA-256 with what the uploader declared, and only then commits the artifact metadata. A mismatch marks the
  version `failed` (never usable), deletes the object and increments `somework_artifact_integrity_failures_total`.
  Results can only reference verified artifacts (`artifact_not_ready` / `integrity_failure` otherwise).
* If the store is unreachable, artifact-dependent completions return `unavailable` (retryable) and the task stays
  `running`; they succeed once the store returns. Stale pending uploads are swept (`expire_stale_uploads`).

Bucket guidance (the service cannot enforce these, the bucket policy must):

* Enable **versioning** and a **lifecycle** rule that expires non-current versions per classification/retention.
  Object keys are `<domain>/<artifactId>/v<version>` and never rewritten, so versioning is purely a safety net.
* Use **object lock** (compliance mode) for audit-grade artifacts.
* Replicate the bucket (cross-region or cross-account) for DR: the SQLite backup records bucket/endpoint in the
  manifest but does not copy object bytes. The restore procedure re-points the restored domain at the replica.
* Use a dedicated IAM user whose permissions are limited to the bucket: GetObject, PutObject, DeleteObject,
  ListBucket, multipart actions. Rotate it by updating `[objects.s3]` and restarting; agents are unaffected because
  they only hold short-lived URLs.

## 5. Key management

* The **master key** (AES-256-GCM) encrypts the domain signing keys at rest. It lives in `SOMEWORK_MASTER_KEY`,
  `domain.master_key`, or `<db>.masterkey` (mode 0600, created on first start of a *new* database only). Starting
  an existing database without its key fails loudly instead of minting a new key.
* **Domain signing keys** (Ed25519) sign task grants and federation grants. `POST /v1/admin/signing-keys/rotate`
  retires the active key and creates a new one; retired public keys stay in `signing_keys` so old signatures remain
  verifiable for the audit retention period. In production the master key should be wrapped by a KMS/HSM (the
  `seal`/`open` interface in `secrets.rs` is the seam).
* **Workload keys** are per-principal Ed25519 keys (`somework admin enroll-agent`); rotate with
  `PATCH /v1/admin/principals/{kind}/{id}`.
* Back up the master key separately and test restoring with it (`restore_fails_clearly_without_the_master_key`).

## 7. Matrix E2EE key custody (encrypted_with_observer)

State: Olm accounts, Olm sessions and Megolm sessions in the `matrix_crypto_*` / `matrix_megolm_*` tables, every pickle
sealed with the master key. The ordinary snapshot backup (section 2) already contains them, and `somework restore`
refuses a backup whose sealed secrets cannot be opened or whose stored Megolm test vector does not decrypt, so a wrong
master key is caught at restore time.

* **Recovery bundle** (independent of the master key): `SOMEWORK_CRYPTO_PASSPHRASE=... somework matrix-crypto export
  --config somework.toml --out crypto.bundle` (mode 0600, PBKDF2-HMAC-SHA256 600k iterations by default, AES-256-GCM).
  Store the bundle and the passphrase in different places. Export after the first start and after each device rotation.
* **Verify** (run after every restore/upgrade): `somework matrix-crypto verify` opens every sealed secret and decrypts
  the Megolm test vector.
* **Recover** after losing the database or master key: restore the domain, then
  `SOMEWORK_CRYPTO_PASSPHRASE=... somework matrix-crypto import --from crypto.bundle` (re-seals with the current master
  key), `matrix-crypto verify`, restart. The same device identity and Megolm sessions continue.
* **No bundle**: the bridge provisions a fresh device on start and deletes the stale `SW*` devices. History from before
  the loss stays unreadable to the bridge; canonical state in SQLite is unaffected. Humans' clients share the current
  session with the new device on their next send.
* **Rotation**: Megolm sessions rotate automatically (membership change, 100 messages, 7 days); rotate a device after a
  suspected compromise through `CryptoManager::rotate_device` (restart-free) and then re-export the bundle. Rotating the
  master key requires re-sealing: export, replace the key, import.
* Alert on `somework_matrix_undecryptable_events_total` growth: in `encrypted_with_observer` it means missing keys,
  in `metadata_only_private` it is expected.

## 8. Limitations (honest list)

* **Single-writer database.** Horizontal scale-out across hosts is not supported; HA is volume failover or
  Litestream-style replication with a short promotion step. Write-heavy bursts above ~1k durable writes/s will queue
  on the SQLite write lock.
* **No built-in PITR.** Snapshot backups give restore points at the backup interval; point-in-time recovery needs
  Litestream (or similar) alongside.
* **Backups are same-process-visible.** `VACUUM INTO` reads the live database; very large databases make backups
  proportionally slower and temporarily double disk use.
* **S3 bytes are not backed up by SomeWork.** Protect the bucket (versioning/replication/object lock).
* **KMS integration is a seam, not a feature**: the master key is a local secret unless you wrap it yourself.
* **Hard links assume a single filesystem** for cheap object backups; across filesystems objects are copied.
* The S3 client targets AWS S3 and MinIO semantics. Other implementations must support presigned query auth,
  multipart uploads and (optionally) conditional writes.
