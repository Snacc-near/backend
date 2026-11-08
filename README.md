# backend

M5 indexer-api: pemindai event `NEP-297` + endpoint `/api/crucible/*`. Backlog: `INT-101..108`, `VC-020..023`.

## Status (scaffold `INT-101..108`)

Node.js + TypeScript murni (`node:http`, 0 dependency runtime). Kontrak dikonfigurasi lewat env — default testnet:

```bash
npm install
npm test                      # unit test (RPC + NEAR AI Cloud di-stub, tidak butuh jaringan)
CONTRACT_ID=snacc-v001.testnet npm start   # :8787 (RPC default https://test.rpc.fastnear.com; override via RPC_URL)
```

| Endpoint | Status |
| --- | :-: |
| `GET /api/crucible/macro` | ✅ live dari RPC `get_macro_state` (503 + `contract_not_deployed` bila kontrak belum ada) |
| `GET /api/strains` (alias `/api/crucible/strains`) | ✅ live: `nft_total_supply` + `get_strain` per id → `{strains, starvingCount, liquidatedCount, splicedCount, totalMinted, truncated}` (maks 200) |
| `GET /api/strains/:id` | ✅ live dari RPC `get_strain` (404 bila tidak ada) |
| `GET /api/strains/:id/svg` (alias `/api/crucible/strains/:id/svg`) | ✅ live: SVG NEP-177 didekode dari `nft_token.metadata.media` → `image/svg+xml` |
| `GET /api/colony/:owner` | ✅ live: `get_colony` + `get_colony_atp` (400 bila account id tak valid) |
| `GET /api/dividends[?epoch=&strain_id=]` | ✅ live: `get_dividend_pool` + `get_epoch_dividend_rate` (24 epoch terakhir) + `get_dividend_contribution` opsional |
| `GET /api/appetite` | ✅ live: `get_appetite_meter` + `get_top_feeder` (epoch berjalan) |
| `GET /api/zones` | 🟡 zona sekarang live (`get_appetite_meter` + `get_macro_state`); riwayat `zone_changed` hanya dari event cache dan ditandai `history_complete:false` (kontrak tidak punya view riwayat zona) |
| `GET /api/tee/attestation-report` | ✅ live: proxy publik `cloud-api.near.ai/v1/attestation/report` (cache 60 dtk) → `{model, signingAddress, gatewayAttestation, modelAttestations}` |
| `GET /api/events` | 🔴 poller tidak berfungsi — lihat catatan di bawah; selalu `indexer_incomplete:true` |
| `POST /api/tee/evaluate-genome` | ✅ (`VC-015`) Tahap 1–3 nyata, dipagari — lihat bagian di bawah. Tanpa `NEAR_AI_API_KEY` di env server → `503 {error:"tee_not_configured"}` (backend publik sengaja tanpa kunci) |

### `POST /api/tee/evaluate-genome` (VC-015)

Kunci `NEAR_AI_API_KEY` hanya dibaca dari env server (`node --env-file=...`), hanya dikirim ke `cloud-api.near.ai`, tidak pernah di-log/dikembalikan. Hanya **pemilik strain** yang boleh memanggil, dibuktikan dengan pesan **NEP-413** (`signMessage` dompet):

```jsonc
// request  (Content-Type: application/json, ≤ 16 KB)
{
  "strain_id": 5,
  "payload_text": "…teks katalis (akun/email/kunci disensor Layer 1)…",   // ≤ 4000 karakter
  "raw_formula": "Ignis-Spore: 3, Lumin-Spore: 2",                          // ≤ 1000 karakter, disembunyikan di balik komitmen
  "auth": {
    "account_id": "alice.testnet",
    "public_key": "ed25519:…",        // harus kunci FullAccess milik akun (view_access_key)
    "signature": "<base64 64 byte>",
    "nonce": "<base64 32 byte acak, sekali pakai>",
    "message": "{\"action\":\"evaluate-genome\",\"strain_id\":5,\"timestamp\":1800000000000}"  // timestamp = ms epoch
  }
}
```

Penanda tangan memakai `recipient: "snacc-backend"` dan tanpa `callbackUrl`. Syarat: `message.strain_id` = `strain_id` body, `account_id` = `owner_id` strain (`get_strain`), `timestamp` tidak lebih tua dari 5 menit (maks 60 dtk di depan), nonce belum pernah dipakai.

```jsonc
// 200
{ "chatId", "signedText", "signatureHex", "signingAddress",
  "raw_response_body",               // string: byte respons enclave utuh (untuk apply)
  "mutation": { "efficiency_shift_bps", "vitality_bonus", "phenotype_trait" },
  "redactionReport": { "redaction_mode", "classification", "warnings", "commitment_hex", "salt_hex",
                       "request_sha256_hex", "payload_terredaksi", "signature_verified" } }
```

**Langkah lanjutan commit → apply on-chain** (dilakukan klien/FE dengan dompet pemilik; backend tidak pernah menandatangani transaksi). Hash request baru diketahui sesudah panggilan ini (salt acak server), sehingga `commit` dilakukan sesudahnya:

1. `signer` enclave (`signingAddress`, hex 32 byte) harus sudah terdaftar di kontrak lewat `register_attested_signer` (khusus owner kontrak) — satu kali.
2. `commit_genome_experiment({ strain_id, req_sha256_hex: redactionReport.request_sha256_hex })`.
3. `apply_tee_mutation_zero_trust({ strain_id, req_sha256_hex: redactionReport.request_sha256_hex, raw_response_body, signature_hex: signatureHex, tee_pubkey_hex: signingAddress })`. `raw_response_body` harus dikirim **tanpa diubah satu byte pun** (kontrak menghitung ulang sha256-nya dan mencocokkan dengan `signedText`); `chatId` dipakai sekali (anti-replay).
4. Kontrak menolak bila `strain_id` di payload mutasi ≠ `strain_id` transaksi — gunakan `strain_id` yang sama dengan request evaluate.

Catatan jujur: urutan ADR-21 fase 1 ("commit sebelum memanggil enclave") tidak tercapai di jalur ini; commit hanya mengikat hash yang sudah dihitung.

Galat: `400 invalid_request|invalid_json|invalid_account_id` · `401 auth_required|invalid_message|signature_expired|invalid_nonce|nonce_reused|invalid_signature` · `403 public_key_not_owned|public_key_not_full_access|not_strain_owner` · `404 strain_not_found` · `405` (bukan POST) · `413 body_too_large` · `429 rate_limited` (+ header `Retry-After`; **3/jam per strain**, **50/hari total**, in-memory) · `502 tee_upstream_failed|tee_guardrail_rejected` · `503 tee_not_configured|rpc_unavailable|contract_not_deployed`.

Logika redaksi + klien enclave di `src/oracle/` adalah salinan terversi dari repo `oracle-tee` (lihat `src/oracle/SYNC.md`; ada test drift). Endpoint ini tidak memberi CORS; panggil dari server/proxy yang sama dengan frontend.

Prinsip: **tidak pernah mengarang data** — endpoint yang belum diimplement merespons `501 {error:"not_implemented", todo:"<ID>"}`; kontrak belum deploy → `503 {error:"contract_not_deployed"}`; RPC hulu gagal/ditolak (mis. 429 setelah 3 retry) → `503 {error:"rpc_unavailable"}`. u128 dan sentinel u64 besar (`atp_balance`, `feast_volume`, `last_allocate_epoch`, …) selalu **string** presisi.

**Catatan poller event (`INT-102` lanjutan, belum tuntas):** RPC `chunk` tidak membawa log eksekusi (hanya receipt mentah) dan `block.header.chunk_ids` tidak ada (field-nya `block.chunks[]`), jadi poller tidak pernah menangkap event. Indexer yang benar perlu `EXPERIMENTAL_tx_status` per transaksi ke kontrak atau indexer eksternal. Karena itu daftar strain kini dibaca dari view, bukan dari event.

Spec: `snacc-vault/` · Skema JSON: [`docs/api-schemas.md`](../docs/api-schemas.md) di repo payung.
