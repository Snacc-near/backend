# backend

M5 indexer-api: pemindai event `NEP-297` + endpoint `/api/crucible/*`. Backlog: `INT-101..108`, `VC-020..023`.

## Status (scaffold `INT-101..108`)

Node.js + TypeScript murni (`node:http`, 0 dependency runtime). Kontrak dikonfigurasi lewat env — default testnet:

```bash
npm install
npm test                      # 22 unit test (RPC di-stub, tidak butuh jaringan)
CONTRACT_ID=snacc-v001.testnet npm start   # :8787
```

| Endpoint | Status |
| --- | :-: |
| `GET /api/crucible/macro` | ✅ live dari RPC `get_macro_state` (503 + `contract_not_deployed` bila kontrak belum ada) |
| `GET /api/strains` | ✅ dari event cache (`strain_created`), flag `indexer_incomplete` |
| `GET /api/strains/:id` | ✅ live dari RPC `get_strain` (404 bila tidak ada) |
| `GET /api/events` | ✅ dari poller block (chunk terakhir per interval) |
| `/api/strains/:id/svg`, `/api/colony/:owner`, `/api/dividends`, `/api/zones`, `/api/appetite`, `/api/tee/*` | 501 stub dengan ID backlog |

Prinsip: **tidak pernah mengarang data** — endpoint yang belum diimplement merespons `501 {error:"not_implemented", todo:"<ID>"}`; kontrak belum deploy → `503 {error:"contract_not_deployed"}`.

Spec: `snacc-vault/` · Skema JSON: [`docs/api-schemas.md`](../docs/api-schemas.md) di repo payung.
