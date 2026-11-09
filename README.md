# backend

M5 indexer-api: `NEP-297` event scanner + `/api/crucible/*` endpoints. Backlog: `INT-101..108`, `VC-020..023`.

## Status (scaffold `INT-101..108`)

Pure Node.js + TypeScript (`node:http`, 0 runtime dependencies). The contract is configured via env — testnet by default:

```bash
npm install
npm test                      # unit tests (RPC + NEAR AI Cloud stubbed, no network needed)
CONTRACT_ID=snacc-v001.testnet npm start   # :8787 (default RPC pool: drpc → fastnear → intear → near.org; override via RPC_URLS/RPC_URL)
```

| Endpoint | Status |
| --- | :-: |
| `GET /api/crucible/macro` | ✅ live from RPC `get_macro_state` (503 + `contract_not_deployed` if the contract is not deployed) |
| `GET /api/strains` (alias `/api/crucible/strains`) | ✅ live: `nft_total_supply` + `get_strain` per id → `{strains, starvingCount, liquidatedCount, splicedCount, totalMinted, truncated}` (max 200) |
| `GET /api/strains/:id` | ✅ live from RPC `get_strain` (404 if not found) |
| `GET /api/strains/:id/svg` (alias `/api/crucible/strains/:id/svg`) | ✅ live: NEP-177 SVG decoded from `nft_token.metadata.media` → `image/svg+xml` |
| `GET /api/colony/:owner` | ✅ live: `get_colony` + `get_colony_atp` (400 if account id is invalid) |
| `GET /api/dividends[?epoch=&strain_id=]` | ✅ live: `get_dividend_pool` + `get_epoch_dividend_rate` (last 24 epochs) + optional `get_dividend_contribution` |
| `GET /api/appetite` | ✅ live: `get_appetite_meter` + `get_top_feeder` (current epoch) |
| `GET /api/zones` | 🟡 current zone is live (`get_appetite_meter` + `get_macro_state`); `zone_changed` history comes only from the in-memory event cache and is marked `history_complete:false` (the contract has no zone history view) |
| `GET /api/tee/attestation-report` | ✅ live: public proxy for `cloud-api.near.ai/v1/attestation/report` (60s cache) → `{model, signingAddress, gatewayAttestation, modelAttestations}` |
| `GET /api/events` | 🟡 live poller v2 (`src/poller.ts`): tx discovery via the NearBlocks v3 account feed (1 call/tick, no key) + `EVENT_JSON` from the `tx` RPC (≤5 new txs/tick); `indexer_incomplete:false` only while the source is healthy and the backfill queue is drained, `true` during failures/backoff; lag in the `x-indexer-lag-blocks` response header |
| `GET /api/health` | ✅ liveness + RPC pool snapshot (INT-rpc-fallback): `{ok, contractId, rpc:{currentHost, endpoints:[{host, cooldownUntil, cooldownSeconds, failures}], cache:{hits, misses, staleServed, size}}, indexer_incomplete}` — hosts only, no secrets |
| `POST /api/tee/evaluate-genome` | ✅ (`VC-015`) Stages 1–3 live, gated — see section below. Without `NEAR_AI_API_KEY` in the server env → `503 {error:"tee_not_configured"}` (public backend intentionally runs without a key) |

### Environment (`INT-rpc-fallback`)

Public testnet RPCs rate-limit per source IP (observed: HTTP 429 on `fastnear`/`near.org` from the server IP), so the client treats RPC as an **ordered pool**: on 429/5xx/timeout/network error it rotates to the next endpoint with exponential backoff + jitter, remembers the last healthy endpoint, and cools a 429'd endpoint down (exponential; a server `Retry-After` is honored). Contract views (`call_function`) are cached briefly (default 10 s, in-flight de-duplicated); while every endpoint fails, a cached view up to 120 s old is served stale with an `x-data-stale-seconds` header — never fabricated data. Errors are never cached as data.

| Env | Default | Purpose |
| --- | :-: | --- |
| `RPC_URLS` | `https://near-testnet.drpc.org,https://test.rpc.fastnear.com,https://testnet-rpc.intea.rs,https://rpc.testnet.near.org` | Ordered pool of public testnet RPCs (from the official NEAR provider list `docs.near.org/api/rpc/providers`) |
| `RPC_URL` | — | Legacy single-endpoint override (used as a one-item pool when `RPC_URLS` is unset) |
| `VIEW_CACHE_TTL_MS` | `10000` | Fresh-serve window for cached contract views |
| `VIEW_STALE_TTL_MS` | `120000` | Oldest cached view still served (labelled stale) while all endpoints fail |
| `RPC_COOLDOWN_BASE_MS` | `60000` | Base per-endpoint cooldown after a 429 (doubles per consecutive 429, cap 10 min) |

### `POST /api/tee/evaluate-genome` (VC-015)

The `NEAR_AI_API_KEY` is read strictly from the server environment (`node --env-file=...`), sent only to `cloud-api.near.ai`, and never logged or returned. Only the **strain owner** may call this endpoint, proven with a signed **NEP-413** message (wallet `signMessage`):

```jsonc
// request  (Content-Type: application/json, ≤ 16 KB)
{
  "strain_id": 5,
  "payload_text": "…catalyst text (account/email/key redacted by Layer 1)…",   // ≤ 4000 chars
  "raw_formula": "Ignis-Spore: 3, Lumin-Spore: 2",                              // ≤ 1000 chars, hidden behind commitment
  "auth": {
    "account_id": "alice.testnet",
    "public_key": "ed25519:…",        // must be a FullAccess key owned by the account (view_access_key)
    "signature": "<base64 64 bytes>",
    "nonce": "<base64 32 random bytes, single-use>",
    "message": "{\"action\":\"evaluate-genome\",\"strain_id\":5,\"timestamp\":1800000000000}"  // timestamp = epoch ms
  }
}
```

The signer uses `recipient: "snacc-backend"` and no `callbackUrl`. Requirements: `message.strain_id` = body `strain_id`, `account_id` = strain `owner_id` (`get_strain`), `timestamp` no older than 5 minutes (max 60s clock skew into the future), and `nonce` never used before.

```jsonc
// 200
{ "chatId", "signedText", "signatureHex", "signingAddress",
  "raw_response_body",               // string: exact raw enclave response bytes (for on-chain apply)
  "mutation": { "efficiency_shift_bps", "vitality_bonus", "phenotype_trait" },
  "redactionReport": { "redaction_mode", "classification", "warnings", "commitment_hex", "salt_hex",
                       "request_sha256_hex", "payload_terredaksi", "signature_verified" } }
```

**Follow-up commit → apply on-chain steps** (performed by the client/FE with the owner's wallet; the backend never signs transactions). The request hash is known only after this call (random server salt), so `commit` is submitted right after:

1. The enclave `signer` (`signingAddress`, 32-byte hex) must already be registered on the contract via `register_attested_signer` (contract owner only) — one-time setup.
2. `commit_genome_experiment({ strain_id, req_sha256_hex: redactionReport.request_sha256_hex })`.
3. `apply_tee_mutation_zero_trust({ strain_id, req_sha256_hex: redactionReport.request_sha256_hex, raw_response_body, signature_hex: signatureHex, tee_pubkey_hex: signingAddress })`. `raw_response_body` must be passed **without altering a single byte** (the contract recomputes its sha256 and matches it against `signedText`); `chatId` is single-use (anti-replay).
4. The contract rejects the call if `strain_id` inside the mutation payload ≠ transaction `strain_id` — use the same `strain_id` as the evaluate request.

Honesty note: the strict ADR-21 phase-1 ordering ("commit before calling the enclave") is not achieved on this server-salted path; the commit binds the hash after it has been computed.

Errors: `400 invalid_request|invalid_json|invalid_account_id` · `401 auth_required|invalid_message|signature_expired|invalid_nonce|nonce_reused|invalid_signature` · `403 public_key_not_owned|public_key_not_full_access|not_strain_owner` · `404 strain_not_found` · `405` (not POST) · `413 body_too_large` · `429 rate_limited` (+ `Retry-After` header; **3/hour per strain**, **50/day total**, in-memory) · `502 tee_upstream_failed|tee_guardrail_rejected` · `503 tee_not_configured|rpc_unavailable|contract_not_deployed`.

The redaction logic + enclave client in `src/oracle/` is a versioned copy from the `oracle-tee` repo (see `src/oracle/SYNC.md`; guarded by a drift test). This endpoint does not set CORS headers; call it from the same origin/proxy as the frontend.

Principle: **never fabricate data** — unimplemented endpoints respond `501 {error:"not_implemented", todo:"<ID>"}`; undeployed contract → `503 {error:"contract_not_deployed"}`; upstream RPC failure/rejection (e.g. 429 after 3 retries) → `503 {error:"rpc_unavailable"}`. `u128` fields and large `u64` sentinels (`atp_balance`, `feast_volume`, `last_allocate_epoch`, …) are always exact **strings**.

**Event poller note (INT-102, poller v2 in `src/poller.ts`):** RPC `chunk` does not carry execution logs (receipt `outcome` is empty by definition — receipts execute later), and `block.header.chunk_ids` does not exist (the field is `block.chunks[]` with `chunk_hash`); scanning every block × chunk on the free public RPC also exhausts its 429 quota in under a minute (observed live). The poller therefore keeps the recorded decision (`docs/indexer-decision.md`, option E — parse `EVENT_JSON` from `tx` outcomes) but discovers transactions via the **NearBlocks v3 account feed** (`https://api-testnet.nearblocks.io/v3/accounts/<contract>/txns`, no API key, newest-first): **one discovery call per tick** (the unauthenticated limit allows a burst of ~4 requests and recovers in ~12 s, measured 2026-11-09), then ≤5 `tx` RPC calls per tick for the new txs, which include the cross-contract callback receipts. The tx list page (limit 50 on the first call = a small backfill, 25 afterwards) also gives `/api/events` history right after a restart. Any 429/5xx arms a global exponential backoff (base = the poll interval, doubling per consecutive failure, cap 10 min); backing-off ticks make **zero** API calls. The cursor = the newest absorbed tx's `(block_timestamp_ns, block_height)`; it advances only after absorption, so a crash re-discovers the queued txs (no silent loss). Memory bounds: ≤5000 events (oldest evicted, counted in `droppedEvents`), ≤100 queued txs, ≤2000 seen txs / 20000 seen receipts. `indexer_incomplete` is `true` while the source is failing/backing off or the queue is not drained; the lag header means `chain head − the block of the newest contract tx absorbed` (it grows when the contract is quiet — there is genuinely no recent activity). The strain list still comes from contract views (events feed `/api/events` and the `zone_changed` history).

Spec: `snacc-vault/` · JSON schemas: [`docs/api-schemas.md`](../docs/api-schemas.md) in the umbrella repo.
