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
PATCH  /api/caches/{cache}/config
DELETE /api/caches/{cache}
DELETE /api/caches/{cache}/paths/{store-hash}
POST   /api/caches/{cache}/missing
POST   /api/uploads
PUT    /api/uploads/{id}/parts/{part-number}
POST   /api/uploads/{id}/complete
GET    /api/uploads/{id}
DELETE /api/uploads/{id}
GET    /health
```

Global control-plane operations, including cache creation, require an admin
grant for `*`; a cache-scoped admin grant is limited to that cache. Upload
cancellation is accepted through `QUEUED`, but returns a transition conflict
once processing or publication has started.

Upload identity is an opaque ID allocated by the cache coordinator. A retry
with the same key and request fingerprint returns the existing job; reusing
the key with different metadata returns `idempotency_conflict`. Upload operations
authenticate on every request and recheck the job's cache grant.

Private-cache token status is edge-cached for up to five seconds after an
active catalog check. Revocation therefore propagates within that bounded
window while avoiding a catalog Durable Object hop on every Nix read.

Publication and deletion use the same durable protocol: an index mutation is
prepared and locked, the exact size delta is reserved in the quota ledger,
the index is committed, then the reservation is finalized. Pending positive
reservations count against available quota, so a visible record is always
backed by a committed or pending-counted charge.
