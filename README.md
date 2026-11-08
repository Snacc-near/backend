# backend

M5 indexer-api: pemindai event `NEP-297` + endpoint `/api/crucible/*`. Backlog: `INT-101..108`, `VC-020..023`.

## Status (scaffold `INT-101..108`)

Node.js + TypeScript murni (`node:http`, 0 dependency runtime). Kontrak dikonfigurasi lewat env — default testnet:

```bash
npm install
npm test                      # 36 unit test (RPC di-stub, tidak butuh jaringan)
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
| `POST /api/tee/evaluate-genome` | 501 (`VC-015`): butuh `NEAR_AI_API_KEY` di server + pipeline `oracle-tee`; backend publik sengaja tanpa kunci |

Prinsip: **tidak pernah mengarang data** — endpoint yang belum diimplement merespons `501 {error:"not_implemented", todo:"<ID>"}`; kontrak belum deploy → `503 {error:"contract_not_deployed"}`; RPC hulu gagal/ditolak (mis. 429 setelah 3 retry) → `503 {error:"rpc_unavailable"}`. u128 dan sentinel u64 besar (`atp_balance`, `feast_volume`, `last_allocate_epoch`, …) selalu **string** presisi.

**Catatan poller event (`INT-102` lanjutan, belum tuntas):** RPC `chunk` tidak membawa log eksekusi (hanya receipt mentah) dan `block.header.chunk_ids` tidak ada (field-nya `block.chunks[]`), jadi poller tidak pernah menangkap event. Indexer yang benar perlu `EXPERIMENTAL_tx_status` per transaksi ke kontrak atau indexer eksternal. Karena itu daftar strain kini dibaca dari view, bukan dari event.

Spec: `snacc-vault/` · Skema JSON: [`docs/api-schemas.md`](../docs/api-schemas.md) di repo payung.
