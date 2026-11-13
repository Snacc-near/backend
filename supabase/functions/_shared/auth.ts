/**
 * `near-auth` core: NEP-413 challenge/verify -> Supabase session, independent of Deno and supabase-js
 * (the Edge Function wires a Postgres/Auth-backed `AuthStore`; tests use an in-memory one).
 */

import { fail, ok, type HandlerResult } from "./http.ts";
import { base64Decode, base64Encode, sha256Hex, verifyNep413, parseEd25519PublicKey } from "./nep413.ts";
import { NearRpcError, type AccessKeyView } from "./near-rpc.ts";
import { AUTH_RECIPIENT, NONCE_TTL_MS, challengeMessage, isValidTestnetAccountId } from "./rules.ts";

export interface NonceRow {
  nonce: string;
  account_id: string;
  expires_at: string;
  used_at: string | null;
}

export interface AuthStore {
  insertNonce(row: { nonce: string; account_id: string; expires_at: string }): Promise<void>;
  getNonce(nonce: string): Promise<NonceRow | null>;
  /** Atomically set `used_at` iff the row is still unused, unexpired and owned by `accountId`; true when this call consumed it. */
  consumeNonce(nonce: string, accountId: string, nowIso: string): Promise<boolean>;
  /** `user_id` of an existing profile for this account, if any. */
  findUserIdByAccount(accountId: string): Promise<string | null>;
  /** Create a confirmed auth user; "exists" when the email is already registered. */
  createUser(email: string, accountId: string): Promise<"created" | "exists">;
  /** `auth.admin.generateLink({ type: "magiclink", email })`. */
  generateMagicLink(email: string): Promise<{ userId: string; hashedToken: string }>;
  upsertProfile(userId: string, accountId: string): Promise<void>;
}

export interface AuthDeps {
  store: AuthStore;
  viewAccessKey: (accountId: string, publicKey: string) => Promise<AccessKeyView | null>;
  now?: () => number;
  randomBytes?: (n: number) => Uint8Array;
  /** Email domain for the synthetic auth users (default `snacc-nu.vercel.app`). */
  emailDomain?: string;
}

export const DEFAULT_EMAIL_DOMAIN = "snacc-nu.vercel.app";

/** Deterministic synthetic email: `near-<first 24 hex of sha256(accountId)>@<domain>`. */
export async function emailForAccount(accountId: string, domain = DEFAULT_EMAIL_DOMAIN): Promise<string> {
  return `near-${(await sha256Hex(accountId)).slice(0, 24)}@${domain}`;
}

function defaultRandom(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

/** Canonical (padded, standard) base64 of a 32-byte nonce, or `null`. */
function canonicalNonce(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const b = base64Decode(s);
  return b && b.length === 32 ? base64Encode(b) : null;
}

/** POST /near-auth/challenge `{ accountId }`. */
export async function handleChallenge(body: Record<string, unknown> | null, deps: AuthDeps): Promise<HandlerResult> {
  if (!body) return fail(400, "bad_request", "Expected a JSON object body.");
  const accountId = body["accountId"];
  if (!isValidTestnetAccountId(accountId)) {
    return fail(400, "invalid_account_id", "accountId must be a .testnet account or a 64-hex implicit account.");
  }
  const now = (deps.now ?? Date.now)();
  const nonce = base64Encode((deps.randomBytes ?? defaultRandom)(32));
  const expiresAt = new Date(now + NONCE_TTL_MS).toISOString();
  await deps.store.insertNonce({ nonce, account_id: accountId, expires_at: expiresAt });
  return ok({ nonce, message: challengeMessage(accountId), recipient: AUTH_RECIPIENT, expiresAt });
}

/** POST /near-auth/verify `{ accountId, publicKey, signature, nonce, message, recipient }`. */
export async function handleVerify(body: Record<string, unknown> | null, deps: AuthDeps): Promise<HandlerResult> {
  if (!body) return fail(400, "bad_request", "Expected a JSON object body.");
  const { accountId, publicKey, signature, message, recipient } = body;
  if (!isValidTestnetAccountId(accountId)) {
    return fail(400, "invalid_account_id", "accountId must be a .testnet account or a 64-hex implicit account.");
  }
  if (typeof publicKey !== "string" || !parseEd25519PublicKey(publicKey)) {
    return fail(400, "invalid_public_key", "publicKey must be ed25519:<base58 of 32 bytes>.");
  }
  const sig = typeof signature === "string" ? base64Decode(signature) : null;
  if (!sig || sig.length !== 64) return fail(400, "invalid_signature_format", "signature must be base64 of 64 bytes.");
  const nonce = canonicalNonce(body["nonce"]);
  if (!nonce) return fail(400, "invalid_nonce", "nonce must be base64 of 32 bytes.");

  const now = (deps.now ?? Date.now)();
  const row = await deps.store.getNonce(nonce);
  if (!row) return fail(401, "nonce_not_found", "Unknown nonce. Request a new challenge.");
  if (row.account_id !== accountId) return fail(401, "nonce_account_mismatch", "This nonce was issued for a different account.");
  if (row.used_at) return fail(401, "nonce_used", "This nonce was already used. Request a new challenge.");
  if (Date.parse(row.expires_at) <= now) return fail(401, "nonce_expired", "The challenge expired. Request a new one.");

  if (message !== challengeMessage(accountId)) return fail(401, "message_mismatch", "The signed message does not match the challenge.");
  if (recipient !== AUTH_RECIPIENT) return fail(401, "recipient_mismatch", `The signed recipient must be ${AUTH_RECIPIENT}.`);

  const nonceBytes = base64Decode(nonce) as Uint8Array;
  const valid = await verifyNep413(publicKey, { message, nonce: nonceBytes, recipient }, sig);
  if (!valid) return fail(401, "invalid_signature", "The NEP-413 signature is not valid for this public key.");

  let key: AccessKeyView | null;
  try {
    key = await deps.viewAccessKey(accountId, publicKey);
  } catch (e) {
    const detail = e instanceof NearRpcError ? e.message : String(e);
    return fail(503, "rpc_unavailable", "Could not reach NEAR RPC to check the access key. Try again.", { detail: detail.slice(0, 160) });
  }
  if (!key) return fail(403, "access_key_not_found", "This public key is not an access key of the account.");
  if (key.permission.kind !== "FullAccess") {
    return fail(403, "not_full_access_key", "Sign in needs a full-access key; this key is a function-call key.");
  }

  // Compare-and-set: only one concurrent verify can consume the nonce.
  if (!(await deps.store.consumeNonce(nonce, accountId, new Date(now).toISOString()))) {
    return fail(401, "nonce_used", "This nonce was already used. Request a new challenge.");
  }

  const email = await emailForAccount(accountId, deps.emailDomain || DEFAULT_EMAIL_DOMAIN);
  try {
    const existing = await deps.store.findUserIdByAccount(accountId);
    if (!existing) await deps.store.createUser(email, accountId);
    const link = await deps.store.generateMagicLink(email);
    if (existing && existing !== link.userId) {
      return fail(409, "account_conflict", "This NEAR account is linked to a different user.");
    }
    await deps.store.upsertProfile(link.userId, accountId);
    return ok({ tokenHash: link.hashedToken, type: "magiclink", nearAccountId: accountId });
  } catch (e) {
    console.error("near-auth: session creation failed", e instanceof Error ? e.message : String(e));
    return fail(500, "session_failed", "Could not create the session. Try again.");
  }
}
