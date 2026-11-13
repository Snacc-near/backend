# Snacc on Supabase

Profiles, NEAR sign-in, activity, achievements, notifications and a testnet starter pack for Snacc,
on Supabase project `vldhsabgpfxccsljdtye` (a **shared** project: every Snacc table and view ends in
`_snacc`; every Snacc function, trigger and policy starts with `snacc_`). Testnet only.

```
browser (snacc-nu.vercel.app)
  │ 1. POST /near-auth/challenge ─────────────► near-auth ──► auth_nonces_snacc
  │ 2. wallet signMessage (NEP-413)
  │ 3. POST /near-auth/verify ────────────────► near-auth ──► NEAR RPC view_access_key (FullAccess?)
  │                                                       ├─► auth.admin.createUser / generateLink
  │                                                       └─► profiles_snacc
  │ 4. supabase.auth.verifyOtp({ token_hash, type: "magiclink" })  → Supabase session (JWT)
  │ 5. POST /record-tx { txHash } (JWT) ──────► record-tx ──► NEAR RPC EXPERIMENTAL_tx_status
  │                                                       └─► activity_snacc ─(trigger)─► achievements_snacc
  │ 6. POST /starter-pack (JWT) ──────────────► starter-pack ─► faucet Transfer 0.3 NEAR ─► starter_claims_snacc
  │ 7. realtime: notifications_snacc (own rows)
  │
pg_cron (every 10 min) ─► POST /notify-scan (x-cron-secret) ─► nft_tokens_for_owner + get_strain
                                                            └─► notifications_snacc, scan_state_snacc
```

## Layout

| Path | What |
| --- | --- |
| `migrations/20261113000001_snacc_core.sql` | tables, RLS, grants, achievements trigger, views, realtime |
| `migrations/20261113000002_snacc_cron.sql` | inert (`select 1`); the `pg_cron` schedule is in comments, enable by hand |
| `tests/snacc_rls.sql` | RLS/privilege assertions in one rolled-back transaction |
| `functions/_shared/*.ts` | pure TypeScript (Web Crypto + fetch only, no `node:` imports, no Deno globals); compiled and unit-tested by the repo's `npm test` |
| `functions/_deno/db.ts` | Deno-only glue (`Deno.env`, `npm:@supabase/supabase-js@2`) |
| `functions/<name>/index.ts` | `Deno.serve` entry points: `near-auth`, `record-tx`, `notify-scan`, `starter-pack` |
| `config.toml` | `verify_jwt` per function (CLI deploys) |

Contract: `snacc-v001.testnet` (override with `SNACC_CONTRACT_ID`). RPC: `https://test.rpc.fastnear.com`,
then `https://rpc.testnet.fastnear.com`. Transport errors and RPC `INTERNAL_ERROR` move on to the next
endpoint; handler errors are final. `EXPERIMENTAL_tx_status` and `block` fall back to
`https://archival-rpc.testnet.fastnear.com` when regular nodes answer `UNKNOWN_TRANSACTION` (txs older than
the ~5-epoch GC window).

## Tables and RLS

RLS is enabled on every table. "Service only" = RLS on, no policies, all privileges revoked from
`anon`/`authenticated` (only the service role used by the Edge Functions can touch it).

| Table / view | Columns (key) | anon | authenticated | Written by |
| --- | --- | --- | --- | --- |
| `profiles_snacc` | `user_id` pk → auth.users, `near_account_id` unique not null, `username` unique `^[a-z0-9_]{3,20}$`, `avatar_strain_id`, `bio` ≤ 160, `created_at`, `updated_at` | select | select; update **own row**, only `username`, `avatar_strain_id`, `bio` (column grants + `snacc_profiles_guard` trigger blocks `user_id`/`near_account_id`/`created_at` changes) | insert: service (near-auth) |
| `auth_nonces_snacc` | `nonce` pk, `account_id`, `expires_at`, `used_at`, `created_at` | – | – | service |
| `activity_snacc` | `tx_hash` pk, `user_id`, `near_account_id`, `method`, `strain_id`, `block_time`, `created_at` | select | select | service (record-tx) |
| `notifications_snacc` | `id` identity pk, `user_id`, `kind` ∈ starving/distressed/lost/dividend/starter/system, `strain_id`, `title`, `body`, `dedupe_key`, `created_at`, `read_at`; unique (`user_id`, `dedupe_key`) | – | select **own**; update **own**, only `read_at` | service (notify-scan, starter-pack). In `supabase_realtime` |
| `notification_prefs_snacc` | `user_id` pk, booleans `starving`, `distressed`, `lost`, `dividend`, `starter`, `system` (default true), `updated_at` | – | select/insert/update **own** | user |
| `achievements_snacc` | pk (`user_id`, `code`), `earned_at` | select | select | only trigger `snacc_award_achievements()` (security definer) on `activity_snacc` insert |
| `streaks_snacc` (view, `security_invoker`) | `user_id`, `near_account_id`, `current_streak_days`, `last_feed_day` | select | select | – |
| `follows_snacc` | pk (`follower`, `followee`) → profiles_snacc, no self-follow | select | select; insert/delete as `follower = auth.uid()` | user |
| `starter_claims_snacc` | `near_account_id` pk, `user_id`, `amount_yocto`, `tx_hash`, `created_at` | – | – | service (starter-pack) |
| `scan_state_snacc` | `user_id` pk, `near_account_id`, `strains` jsonb (strain id → last status), `scanned_at` | – | – | service (notify-scan) |
| `scan_queue_snacc` (view, `security_invoker`) | profiles left-joined with scan state | – | – | read by notify-scan |

Achievement codes (rules duplicated in `functions/_shared/rules.ts` and pinned by unit tests):
`first_hatch` (≥ 1 `incubate_strain`), `first_feed` (≥ 1 `feed_strain`), `feeds_10` (≥ 10 `feed_strain`),
`streak_3` / `streak_7` (best run of consecutive UTC days with ≥ 1 `feed_strain`), `rescuer` (≥ 1 `adopt`),
`gifter` (≥ 1 `nft_transfer`), `colony_5` (≥ 5 `incubate_strain` + `divide_strain`).
`streaks_snacc.current_streak_days` is the run ending on the last feed day, counted only if that day is
today or yesterday (UTC), else 0.

## HTTP contracts

Base URL: `https://vldhsabgpfxccsljdtye.supabase.co/functions/v1`. All bodies are JSON. Errors are
`{ "error": "<code>", "message": "<plain English>" }` (4xx for caller problems, 5xx for server/RPC problems).
CORS allows `https://snacc-nu.vercel.app`, `http://localhost:4173`, `http://localhost:5173`
(methods `POST, OPTIONS`; headers `authorization, x-client-info, apikey, content-type`).

### `near-auth` (verify_jwt **false**)

`POST /near-auth/challenge`

```json
{ "accountId": "alice.testnet" }
```
→ 200
```json
{ "nonce": "<base64 of 32 random bytes>", "message": "Sign in to Snacc as alice.testnet",
  "recipient": "snacc-nu.vercel.app", "expiresAt": "2026-11-13T10:05:00.000Z" }
```
`accountId` must be a named `*.testnet` account or a 64-hex implicit account (else 400 `invalid_account_id`).
The nonce is stored in `auth_nonces_snacc` and expires after 5 minutes.

`POST /near-auth/verify`

```json
{ "accountId": "alice.testnet", "publicKey": "ed25519:<base58>", "signature": "<base64>",
  "nonce": "<base64>", "message": "Sign in to Snacc as alice.testnet", "recipient": "snacc-nu.vercel.app" }
```
→ 200
```json
{ "tokenHash": "<properties.hashed_token>", "type": "magiclink", "nearAccountId": "alice.testnet" }
```
then the frontend calls `supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" })`.

Checks, in order: body shape (400 `bad_request`, `invalid_account_id`, `invalid_public_key`,
`invalid_signature_format`, `invalid_nonce`); nonce exists (401 `nonce_not_found`), belongs to the account
(401 `nonce_account_mismatch`), unused (401 `nonce_used`), unexpired (401 `nonce_expired`); `message` and
`recipient` are exactly the challenge strings (401 `message_mismatch`, `recipient_mismatch`); NEP-413 signature
(sha256 of tag 2^31+413 ‖ Borsh {message, nonce, recipient, callbackUrl: None}, ed25519) is valid
(401 `invalid_signature`); `publicKey` is an access key of the account (403 `access_key_not_found`) with
**FullAccess** permission (403 `not_full_access_key`); RPC unreachable → 503 `rpc_unavailable`.
Then the nonce is consumed with a compare-and-set update (a concurrent second verify gets 401 `nonce_used`),
the auth user is found or created (`auth.admin.createUser`, `email_confirm: true`,
`user_metadata: { near_account_id }`), `profiles_snacc` is upserted and
`auth.admin.generateLink({ type: "magiclink", email })` provides the token hash (500 `session_failed` on
Auth errors, 409 `account_conflict` if the profile points at another user).
Base64 inputs may be standard or base64url.

Synthetic email: `near-<first 24 hex of sha256(accountId)>@snacc-nu.vercel.app`. No email is ever sent
(admin APIs only). The `.invalid` TLD was not used: recent Supabase Auth releases block RFC 2606 reserved
suffixes (`.invalid`, `.test`, `.example`, `.local`) in their email validation. This has not been tested
against this project; if `createUser` rejects the default domain, set another one. The domain can be changed with
`SNACC_AUTH_EMAIL_DOMAIN`. Changing it after users exist creates new auth users, so set it once.

**Function-call keys.** Some NEAR wallets sign `signMessage` requests with a function-call access key (for
example the limited key a dApp login created) instead of a full-access key. Such a signature can be valid,
but `near-auth` rejects it with **403 `not_full_access_key`**: a function-call key can belong to a
third-party dApp, so it does not prove control of the account. The frontend should show the message and ask
the user to sign with a wallet that uses the account's full-access key.

### `record-tx` (verify_jwt **true**)

`POST /record-tx` with `Authorization: Bearer <session access token>`

```json
{ "txHash": "<base58>" }
```
→ 200
```json
{ "recorded": true, "method": "feed_strain", "achievements": ["first_feed"] }
```
Looks up the caller's `near_account_id`, fetches `EXPERIMENTAL_tx_status` (sender = that account,
`wait_until: FINAL`), requires signer = the account (403 `tx_signer_mismatch`), receiver = the contract
(422 `tx_wrong_receiver`), final status `SuccessValue` (422 `tx_failed`, 409 `tx_pending`), and a FunctionCall
(422 `tx_not_function_call`). Records the first FunctionCall's `method_name` and `strain_id`, else
`target_id`, else `token_id` from its args (for `incubate_strain`, the new `strain_id` from the return value)
with the inclusion block's timestamp. Idempotent on `tx_hash`: a repeat returns `achievements: []`.
`achievements` lists codes newly earned by this call. Other errors: 400 `invalid_tx_hash`, 401 `unauthorized`,
403 `no_profile`, 404 `tx_not_found`, 503 `rpc_unavailable`.

### `notify-scan` (verify_jwt **false**, header `x-cron-secret` = Vault secret `snacc_cron_secret`)

`POST /notify-scan` → 200 `{ "profiles", "strains", "planned", "inserted", "errors", "skipped" }` (counts,
also logged as one JSON line). 401 `unauthorized` on a wrong/missing secret, 503 `not_configured` when the Vault check
`snacc_cron_secret_ok()` is missing. The secret is generated inside the database by
`migrations/20261113000005_snacc_cron_vault.sql` and never copied by hand; the optional `SNACC_CRON_SECRET`
edge secret, when set, takes precedence (older setups keep working).

Takes up to `SNACC_SCAN_MAX_PROFILES` (default 50, max 500) profiles from `scan_queue_snacc`, least recently
scanned first, and stops starting new profiles after 50 s. For each: `nft_tokens_for_owner` (pages of 50, at
most 100 strains) + `get_strain` per token, then inserts (respecting `notification_prefs_snacc`; missing row =
all on):

- `starving`: `effective_vitality` = 0 and not Liquidated/SplicedBurned;
- `distressed`: `effective_vitality` 1..2000;
- `lost`: a strain alive in the previous scan that is now Liquidated/SplicedBurned, or is missing from the
  owner listing and `get_strain` confirms another owner (or no strain). The first scan of a profile never
  reports `lost`.

`dedupe_key` = `<kind>:<strain_id>:<UTC day>`, inserted with `on conflict do nothing`, so each condition
notifies at most once per strain per UTC day. `scan_state_snacc` keeps strain id → last status.

### `starter-pack` (verify_jwt **true**)

`POST /starter-pack` with `Authorization: Bearer <session access token>` (no body)
→ 200 `{ "claimed": true, "txHash": "<base58>", "amountYocto": "300000000000000000000000" }`

Sends 0.3 testnet NEAR from `SNACC_FAUCET_ACCOUNT_ID` once per `near_account_id`, only when the account
holds < 0.3 NEAR (`view_account`; a not-yet-existing implicit account counts as 0), at most 100 claims per
UTC day overall. Writes `starter_claims_snacc` (a reservation row first, so two parallel requests cannot both
pay) and a `starter` notification. Errors: 503 `not_configured` (faucet secrets missing), 401 `unauthorized`,
403 `no_profile`, 409 `already_claimed` (with `txHash`), 409 `balance_sufficient`, 429 `daily_cap_reached`,
502 `transfer_failed` (claim released, retry allowed), 502 `transfer_unknown` (tx submitted but no
confirmation; claim kept with its `txHash` so a retry cannot pay twice), 503 `rpc_unavailable`.

Signer choice: a ~100-line Borsh `Transfer` serializer + Web Crypto Ed25519 (`functions/_shared/near-tx.ts`)
instead of `npm:near-api-js`. The faucet needs exactly one transaction shape, near-api-js brings a large
dependency tree into every cold start, and the hand-written layout is pinned byte-for-byte to a
near-api-js 7.4.0 vector in `test/supabase-rules.test.ts`. The key is parsed once, imported as a
non-extractable `CryptoKey`, and never logged; error messages never include key material.

## Environment and secrets

Injected by Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (all functions use the service role).

| Secret | Used by | Notes |
| --- | --- | --- |
| `SNACC_CRON_SECRET` (optional) | notify-scan | overrides the Vault secret `snacc_cron_secret`; leave unset normally |
| `SNACC_FAUCET_ACCOUNT_ID` | starter-pack | testnet account holding the faucet funds |
| `SNACC_FAUCET_PRIVATE_KEY` | starter-pack | `ed25519:<base58>` full-access key of that account (testnet only) |
| `SNACC_CONTRACT_ID` (optional) | record-tx, notify-scan | default `snacc-v001.testnet` |
| `SNACC_AUTH_EMAIL_DOMAIN` (optional) | near-auth | default `snacc-nu.vercel.app` |
| `SNACC_SCAN_MAX_PROFILES` (optional) | notify-scan | default 50 |

## Apply and deploy (in this order)

1. Apply `migrations/20261113000001_snacc_core.sql` (MCP `apply_migration` or SQL editor). Idempotent;
   creates only `*_snacc` objects and `snacc_*` functions/triggers/policies; never drops anything.
2. Apply `migrations/20261113000002_snacc_cron.sql` (a no-op that records the file).
3. Run `tests/snacc_rls.sql` as `postgres`; expect the notice `ALL SNACC RLS CHECKS PASSED` (it rolls back).
4. Set the secrets (for the starter pack) `SNACC_FAUCET_ACCOUNT_ID`,
   `SNACC_FAUCET_PRIVATE_KEY`.
5. Deploy each function together with `_shared/` and `_deno/`:
   `near-auth` and `notify-scan` with verify_jwt **false**, `record-tx` and `starter-pack` with verify_jwt
   **true** (CLI: `supabase functions deploy <name> --project-ref vldhsabgpfxccsljdtye`, which reads
   `config.toml`).
6. Smoke test: `POST /near-auth/challenge` with `{"accountId":"<you>.testnet"}` returns a nonce; a wrong-origin
   request gets no `Access-Control-Allow-Origin`; `POST /notify-scan` without the header returns 401.
7. Enable the schedule: apply `migrations/20261113000005_snacc_cron_vault.sql` (pg_cron + pg_net, a
   database-generated Vault secret, `snacc_cron_secret_ok()`, and `cron.schedule('snacc_notify_scan',
   '*/10 * * * *', ...)`). The commented steps in `20261113000002_snacc_cron.sql` are superseded.

## Tests

`npm test` compiles `functions/_shared/**` with the backend's `tsc` (`rewriteRelativeImportExtensions` turns the
Deno-style `.ts` imports into `.js`) and runs:

- `test/supabase-nep413.test.ts`: base58/base64, NEP-413 hash and Web Crypto verify (valid, tampered message,
  wrong recipient, wrong nonce, other key, junk), equivalence with the `node:crypto` verifier in `src/nep413.ts`;
- `test/supabase-near-rpc.test.ts`: RPC fallback and error classes, access-key permission parser, tx-status
  parser on real `snacc-v001.testnet` fixtures (`test/fixtures/`), the record-tx handler;
- `test/supabase-auth.test.ts`: challenge/verify contract, nonce lifecycle, function-call key rejection, CORS;
- `test/supabase-rules.test.ts`: achievements/streaks, notify-scan planning, starter-pack handler, signer vector.

The `index.ts` entry points and the SQL are not executed by `npm test`.
