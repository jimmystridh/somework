# Garage v2.4.1 candidate — tested storage contract, NOT Plane deployment

Main `b924d31224397818e82de53d5beef2b54f3a426b` still selects licensed AIStor.
This focused change does **not** activate a replacement, change `deploy.sh`, accept
vendor terms or use old/unmaintained MinIO CE. Review is required before rollout.

## Authoritative maintenance/security and actual image identity

`provenance.json` records the upstream release, unarchived repository updated
2026-10-12, security reporting policy, AGPL license and resolved source tag.
Services pulled the actual linux/amd64 manifest and ran `/garage --version`:
`garage v2.4.1`. Image has no source labels/attestation; no reproducible-build or
comprehensive vulnerability-free claim is made. Security review/scanning remains
required. Single-node replication has no redundancy; upstream explicitly advises
against replication factor 1 outside test deployments. Production acceptance of
that durability tradeoff (or a replicated topology) is a real decision, not a
claim that test success proves production suitability.

## Actual runtime evidence, 2026-10-14

Isolated Services network `plane-garage-contract` is internal, with **no published
ports**. Only new fixture volume `plane_garage_contract_data` is mounted. The
pinned Plane backend supplies its real boto3, not an emulated signer.

Verified against the pinned Garage image:
- boto3 presigned multipart-form POST: success;
- presigned GET with content disposition: exact content and disposition;
- CopyObject, HeadObject, upload_fileobj: success;
- unsigned request, wrong secret, unknown access key: HTTP 403;
- wrong region: HTTP 400 (rejected, not incorrectly asserted to be 403);
- restart: all three objects and key/bucket permissions persisted;
- ACL and bucket-policy API requests: rejected as unsupported/access denied;
- `GetBucketInfo`: website access false; Plane fixture key: read/write true,
  owner false, createBucket false.

`boto3-contract.py` was executed directly through readable `docker exec -i ...
python -` input and all assertions passed. An earlier standalone head check used
34 instead of the fixture's actual 35 bytes; corrected check passed. No false
claim that the initial assertion passed. The production helper has six passing
stdlib unit tests in the sandbox; its live host execution was **refused** because
subprocess-bearing Python exceeded the approval request length limit. Its new-key
JSON-API path therefore remains runtime-unverified. The fixture was provisioned
with explicit CLI layout/key/bucket commands, not that production helper.

## Candidate configuration and provisioning

`production.compose.yaml` is a **last merge layer**, retaining Plane's storage DNS
name/port, application images, region from environment and proxy. It removes the
AIStor license mount/root environment. New `garage_meta` and `garage_objects`
volumes avoid interpreting an AIStor filesystem as Garage metadata. Existing
`plane_uploads` must remain untouched; there is NO data conversion procedure.
Both metadata and object writes request fsync. RPC is loopback-only; neither an
HTTP admin listener nor a website listener is configured. No object port is
published. `/garage health` is the health check **after layout initialization**.

Generator opt-in: `generate-secrets.mjs PRIVATE_DIR VERIFIED_ORIGIN garage` creates
GK+24-hex access ID, 256-bit S3 secret, explicit `AWS_REGION=garage` and an exclusive
mode-0600 `garage_rpc` file. The licensed default remains unchanged. Production
execution reads/writes secrets and requires host_exec approval; never print them.
A partial creation failure is fail-closed and must not be repaired by overwriting
or rotating existing files.

`provision.py PRIVATE_PLANE_ENV STORAGE_CONTAINER` uses Garage's reviewed v2
JSON-API schemas over loopback RPC. Secret import JSON travels on stdin, never
argv; API responses/errors are captured and never printed. Existing keys are not
reimported/rotated. Wider key grants, public website buckets, bucket-creation or
owner privileges are rejected rather than silently weakened. It preprovisions
`uploads` because Plane's startup performs HeadBucket before CreateBucket. Plane's
unused `update_bucket` command calls unsupported bucket-policy APIs: do NOT enable
that command or claim ACL/policy compatibility.

Before rollout, review the replacement/durability choice, test helper's new-key
path, initialize a measured explicit capacity/layout, adapt deployment ordering
(start Garage, initialize layout/provision, then health/migrations), and test the
actual Plane proxy Host/presigned signature path. Current `deploy.sh` still requires
an AIStor license intentionally; do not bypass it or call this layer a deployment.

## Reproducible isolated contract

From a supported reviewed host checkout, use `test.compose.yaml` in a NEW project.
Start only storage, get its node ID with `/garage status`, assign zone `contract`
and capacity `1G`, then apply layout version 1. Create `uploads`, import PUBLIC
fixture `GK0123456789abcdef01234567` with secret `0123456789abcdef` repeated four
times, allow only read/write on that bucket. These are test-only values, NEVER
production. Run client, restart storage, then run client with `--verify` (read-only
persistence verification). No automated `down -v`, prune or cleanup. Cleanup of
retained diagnostic containers/fixture volumes needs separate approval.

Local tests:

```
COMPOSE_BIN=/path/to/compose node --test deploy/plane/*.test.mjs \
 deploy/plane/ingress/*.test.mjs deploy/plane/storage/*.test.mjs
python3 deploy/plane/storage/garage/provision_test.py
npm run check:roles
```
