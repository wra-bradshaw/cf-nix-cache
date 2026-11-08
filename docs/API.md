# HTTP API

The administrative and upload API is the current `/api` contract. There is no
legacy compatibility adapter. Every mutating API request must carry an
`Idempotency-Key`; callers should reuse a key only while retrying one intended
operation. Reusing a key for a later operation returns the original result (or
an idempotency conflict). Errors use `{code, message, request_id}` and the
request/response shapes are defined by the checked-in API schemas.

The stock Nix substituter wire protocol remains unchanged:

```text
GET|HEAD /cache/{cache}/nix-cache-info
GET|HEAD /cache/{cache}/{store-hash}.narinfo
GET|HEAD /cache/{cache}/nar/{store-hash}.nar.zst
GET      /api/public-key
```

Pull requests to an `ACTIVE` public cache may be anonymous. Private caches
still require a valid, non-revoked capability grant; `CREATING` caches return
503 and `DELETING` caches return 410. Dependency failures are surfaced as
errors rather than being converted to anonymous-cache misses.

Control-plane and upload endpoints:

```text
POST   /api/bootstrap
POST   /api/tokens
GET    /api/tokens?limit=&cursor=
DELETE /api/tokens/{jti}
GET    /api/audit?limit=&cursor=
POST   /api/caches
GET    /api/caches?limit=&cursor=
GET    /api/caches/{cache}
GET    /api/caches/{cache}/upstreams
PATCH  /api/caches/{cache}/config
DELETE /api/caches/{cache}
DELETE /api/caches/{cache}/paths/{store-hash}
POST   /api/caches/{cache}/missing
POST   /api/gc
GET    /api/gc
POST   /api/uploads/encoded
POST   /api/uploads/encoded/batch
PUT    /api/uploads/{id}/chunks/{raw-hash}
POST   /api/uploads/encoded/batch/complete
POST   /api/uploads/{id}/complete
GET    /api/uploads/{id}
DELETE /api/uploads/{id}
GET    /health
```

Global control-plane operations, including cache creation, require an admin
grant for `*`; a cache-scoped admin grant is limited to that cache. Upload
cancellation is accepted through `QUEUED`, but returns a transition conflict
once processing or publication has started.

`POST /api/caches` accepts `upstream_cache_key_names`, the signing key names of
upstream caches, which defaults to `["cache.nixos.org-1"]`. It is a hint: clients
should not upload paths signed with these keys, and the server does not enforce
it. `GET /api/caches/{cache}/upstreams` returns the list to anyone with a push
grant.

`PATCH /api/caches/{cache}/config` accepts `public`, `retention_days` and
`upstream_cache_key_names`, and changes only the fields it is given. With `retention_days` above zero, garbage
collection evicts paths not used for that many days; the default of 0 keeps them
indefinitely. `POST /api/gc` requires an admin grant for `*` and starts a run,
accepting optional `dry_run` and `grace_seconds`. It returns `202` with a
`run_id`. A run does nothing if another is active. `GET /api/gc` reports the
active run and the last finished one. In a dry-run summary, `deleted_objects`
and `deleted_bytes` are what would be deleted, not counting objects that the
reported evictions would also free.

## Uploads

A path is uploaded already split and compressed with the cache's
`encoding_id`: FastCDC v2020 chunks of 1, 4 and 16 MiB minimum, average and
maximum, each one zstd level-3 frame. `POST /api/uploads/encoded` takes the
path's metadata and the ordered chunk list (raw and compressed hash and size of
each chunk) and answers with the raw hashes of the chunks the server lacks, in
`missing_chunks`. The client sends each one with `PUT
/api/uploads/{id}/chunks/{raw-hash}`, then calls `POST
/api/uploads/{id}/complete` with no body. A chunk is checked against its
claimed hashes and sizes before it is stored, and a chunk that fails is answered
with `invalid_chunk` (422) and fails the upload. Completion checks that the
stored chunks concatenate to a valid NAR with the declared hash, and publishes
the path, in the same request for NARs up to 256 MiB. Larger ones are queued for
the processor and complete as `QUEUED`; poll `GET /api/uploads/{id}` until
`READY`. An upload whose NAR the installation already has needs no chunks at
all.

Completion stores the upload's chunk list before publishing, so an interrupted
publication is finished by the processor workflow from the chunks already in
the bucket. A retryable failure starts that workflow before the response; if a
request dies without a response, the next `GET /api/uploads/{id}` (or a push of
the same path) starts it. Recovery never asks the client to send the NAR again.

Small paths, which are one chunk each, can be opened in batches of up to 64 with
`POST /api/uploads/encoded/batch` (`{uploads: [...]}`, answered in order).
`POST /api/uploads/encoded/batch/complete` then sends their missing chunks and
completes them together, as `multipart/form-data` with a `request` field holding
`{ids: [...]}` and one file field per chunk, named by its raw hash.

While garbage collection is deleting objects, opening an upload returns
`gc_in_progress` (503); retry with the same `Idempotency-Key`.

The whole-NAR staging upload of earlier versions is gone: `POST /api/uploads`
and `PUT /api/uploads/{id}/parts/{part-number}` answer `staging_upload_removed`
(410), and an unfinished staging upload left from before the upgrade is marked
FAILED when it is next looked at.

Two pushes of the same path never process it twice. `POST
/api/caches/{cache}/missing` reports a path that another upload is publishing in
`pending`, with that upload's ID, rather than in `missing`. Opening an upload of
a NAR that is already in flight returns that upload with `merged: true`; wait
for it instead of sending anything. A different NAR hash for the same store hash
is a replacement and gets its own upload, and an in-flight upload that fails is
replaced by the next push.

Upload identity is an opaque ID allocated by the cache coordinator. A retry
with the same key and request fingerprint returns the existing job; reusing
the key with different metadata returns `idempotency_conflict`. Upload operations
authenticate on every request and recheck the job's cache grant.

Repeating a token request with the same key signs the token again from its stored
metadata, because the bearer token itself is not stored. It returns `token_revoked`
if that token has since been revoked.

Private-cache token status is edge-cached for up to five seconds after an
active catalog check. Revocation therefore propagates within that bounded
window while avoiding a catalog Durable Object hop on every Nix read.

Publication and deletion use the same durable protocol: an index mutation is
prepared and locked, the exact size delta is reserved in the quota ledger,
the index is committed, then the reservation is finalized. Pending positive
reservations count against available quota, so a visible record is always
backed by a committed or pending-counted charge.
