// near-auth (NEP-413 challenge/verify -> Supabase magic-link token hash) with an in-memory store.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import {
  emailForAccount,
  handleChallenge,
  handleVerify,
  type AuthDeps,
  type AuthStore,
  type NonceRow,
} from "../supabase/functions/_shared/auth.js";
import { corsHeaders, preflight, safeEqual, bearerToken } from "../supabase/functions/_shared/http.js";
import { base58Encode } from "../supabase/functions/_shared/nep413.js";
import type { AccessKeyView } from "../supabase/functions/_shared/near-rpc.js";
import { isValidTestnetAccountId } from "../supabase/functions/_shared/rules.js";

const NOW = Date.UTC(2026, 10, 13, 10, 0, 0);
const ACCOUNT = "alice.testnet";
const RECIPIENT = "snacc-nu.vercel.app";

function newKey(): { priv: KeyObject; pubStr: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { priv: privateKey, pubStr: `ed25519:${base58Encode(x)}` };
}
function bstr(s: string): Buffer {
  const b = Buffer.from(s);
  const l = Buffer.alloc(4);
  l.writeUInt32LE(b.length);
  return Buffer.concat([l, b]);
}
function sign413(priv: KeyObject, message: string, nonce: Buffer, recipient: string): string {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  const ser = Buffer.concat([tag, bstr(message), nonce, bstr(recipient), Buffer.from([0])]);
  return edSign(null, createHash("sha256").update(ser).digest(), priv).toString("base64");
}

interface Mem extends AuthStore {
  nonces: Map<string, NonceRow>;
  users: Map<string, string>; // email -> id
  profiles: Map<string, string>; // user_id -> account
  createCalls: number;
}
function memStore(): Mem {
  const nonces = new Map<string, NonceRow>();
  const users = new Map<string, string>();
  const profiles = new Map<string, string>();
  const m: Mem = {
    nonces,
    users,
    profiles,
    createCalls: 0,
    async insertNonce(row) {
      nonces.set(row.nonce, { ...row, used_at: null });
    },
    async getNonce(n) {
      return nonces.get(n) ?? null;
    },
    async consumeNonce(n, accountId, nowIso) {
      const r = nonces.get(n);
      if (!r || r.used_at || r.account_id !== accountId || Date.parse(r.expires_at) <= Date.parse(nowIso)) return false;
      r.used_at = nowIso;
      return true;
    },
    async findUserIdByAccount(accountId) {
      for (const [uid, acc] of profiles) if (acc === accountId) return uid;
      return null;
    },
    async createUser(email) {
      m.createCalls++;
      if (users.has(email)) return "exists";
      users.set(email, `00000000-0000-4000-8000-${String(users.size + 1).padStart(12, "0")}`);
      return "created";
    },
    async generateMagicLink(email) {
      const id = users.get(email);
      if (!id) throw new Error("user not found");
      return { userId: id, hashedToken: `hashed-${email}` };
    },
    async upsertProfile(userId, accountId) {
      profiles.set(userId, accountId);
    },
  };
  return m;
}

const fullAccess: AccessKeyView = { permission: { kind: "FullAccess" }, nonce: 1n, blockHash: "h" };
function deps(store: Mem, over: Partial<AuthDeps> = {}): AuthDeps {
  return { store, now: () => NOW, viewAccessKey: async () => fullAccess, ...over };
}
const err = (r: { body: unknown }) => (r.body as { error: string }).error;

async function challenge(store: Mem, accountId = ACCOUNT) {
  const r = await handleChallenge({ accountId }, deps(store));
  assert.equal(r.status, 200);
  return r.body as { nonce: string; message: string; recipient: string; expiresAt: string };
}

function verifyBody(c: { nonce: string; message: string; recipient: string }, key = signer, over: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT,
    publicKey: key.pubStr,
    signature: sign413(key.priv, c.message, Buffer.from(c.nonce, "base64"), c.recipient),
    nonce: c.nonce,
    message: c.message,
    recipient: c.recipient,
    ...over,
  };
}
const signer = newKey();

test("account id validation: .testnet named or 64-hex implicit only", () => {
  for (const ok of ["alice.testnet", "sub.alice.testnet", "a_b-c.testnet", "snacc-v001.testnet", "a".repeat(64).replace(/a/g, "f")]) {
    assert.equal(isValidTestnetAccountId(ok), true, ok);
  }
  for (const bad of ["alice.near", "Alice.testnet", "alice..testnet", "-a.testnet", "testnet", "0x" + "f".repeat(40), "F".repeat(64), "", 5, null]) {
    assert.equal(isValidTestnetAccountId(bad), false, String(bad));
  }
});

test("challenge: exact contract shape, 5-minute expiry, stored nonce", async () => {
  const store = memStore();
  const c = await challenge(store);
  assert.deepEqual(Object.keys(c).sort(), ["expiresAt", "message", "nonce", "recipient"]);
  assert.equal(Buffer.from(c.nonce, "base64").length, 32);
  assert.equal(c.message, "Sign in to Snacc as alice.testnet");
  assert.equal(c.recipient, RECIPIENT);
  assert.equal(c.expiresAt, new Date(NOW + 5 * 60 * 1000).toISOString());
  assert.equal(store.nonces.get(c.nonce)?.account_id, ACCOUNT);
  const bad = await handleChallenge({ accountId: "alice.near" }, deps(store));
  assert.equal(bad.status, 400);
  assert.equal(err(bad), "invalid_account_id");
  assert.equal(err(await handleChallenge(null, deps(store))), "bad_request");
});

test("verify: happy path -> tokenHash/magiclink, creates user + profile, nonce consumed", async () => {
  const store = memStore();
  const c = await challenge(store);
  const r = await handleVerify(verifyBody(c), deps(store));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const email = await emailForAccount(ACCOUNT);
  assert.match(email, /^near-[0-9a-f]{24}@snacc-nu\.vercel\.app$/);
  assert.deepEqual(r.body, { tokenHash: `hashed-${email}`, type: "magiclink", nearAccountId: ACCOUNT });
  assert.equal([...store.profiles.values()][0], ACCOUNT);
  assert.ok(store.nonces.get(c.nonce)?.used_at);
  // replay of the same signed body
  const replay = await handleVerify(verifyBody(c), deps(store));
  assert.equal(err(replay), "nonce_used");
  // second sign-in reuses the user (no second createUser)
  const c2 = await challenge(store);
  const r2 = await handleVerify(verifyBody(c2), deps(store));
  assert.equal(r2.status, 200);
  assert.equal(store.createCalls, 1);
  assert.equal(store.users.size, 1);
});

test("verify: base64url nonce/signature accepted (wallet variants)", async () => {
  const store = memStore();
  const c = await challenge(store);
  const b = verifyBody(c);
  const r = await handleVerify(
    { ...b, nonce: Buffer.from(c.nonce, "base64").toString("base64url"), signature: Buffer.from(b.signature, "base64").toString("base64url") },
    deps(store),
  );
  assert.equal(r.status, 200, JSON.stringify(r.body));
});

test("verify: wrong recipient, wrong message, wrong/unknown nonce, other account's nonce, expired", async () => {
  const store = memStore();
  const c = await challenge(store);
  const signedFor = (message: string, recipient: string) => sign413(signer.priv, message, Buffer.from(c.nonce, "base64"), recipient);

  const wrongRecipient = await handleVerify(verifyBody(c, signer, { recipient: "evil.example", signature: signedFor(c.message, "evil.example") }), deps(store));
  assert.equal(err(wrongRecipient), "recipient_mismatch");
  const wrongMessage = await handleVerify(verifyBody(c, signer, { message: "hello", signature: signedFor("hello", RECIPIENT) }), deps(store));
  assert.equal(err(wrongMessage), "message_mismatch");
  const unknownNonce = await handleVerify(verifyBody({ ...c, nonce: randomBytes(32).toString("base64") }), deps(store));
  assert.equal(err(unknownNonce), "nonce_not_found");
  const shortNonce = await handleVerify(verifyBody(c, signer, { nonce: randomBytes(16).toString("base64") }), deps(store));
  assert.equal(err(shortNonce), "invalid_nonce");
  // signature made over a different nonce than the one submitted
  const c2 = await challenge(store);
  const swapped = await handleVerify({ ...verifyBody(c2), nonce: c.nonce }, deps(store));
  assert.equal(err(swapped), "invalid_signature");

  const bob = await challenge(store, "bob.testnet");
  const crossAccount = await handleVerify(verifyBody({ ...bob, message: c.message }), deps(store));
  assert.equal(err(crossAccount), "nonce_account_mismatch");

  const later = await handleVerify(verifyBody(c), deps(store, { now: () => NOW + 5 * 60 * 1000 + 1 }));
  assert.equal(err(later), "nonce_expired");
  assert.equal(store.nonces.get(c.nonce)?.used_at, null);
  assert.equal(store.users.size, 0);
});

test("verify: invalid signature / other key / bad formats", async () => {
  const store = memStore();
  const c = await challenge(store);
  assert.equal(err(await handleVerify(verifyBody(c, signer, { signature: Buffer.alloc(64, 7).toString("base64") }), deps(store))), "invalid_signature");
  const other = newKey();
  assert.equal(err(await handleVerify(verifyBody(c, other, { publicKey: signer.pubStr }), deps(store))), "invalid_signature");
  assert.equal(err(await handleVerify(verifyBody(c, signer, { publicKey: "ed25519:abc" }), deps(store))), "invalid_public_key");
  assert.equal(err(await handleVerify(verifyBody(c, signer, { signature: "!!" }), deps(store))), "invalid_signature_format");
  assert.equal(err(await handleVerify(verifyBody(c, signer, { accountId: "alice.near" }), deps(store))), "invalid_account_id");
  assert.equal(err(await handleVerify(null, deps(store))), "bad_request");
});

test("verify: function-call key -> 403 not_full_access_key; missing key -> access_key_not_found; RPC down -> 503", async () => {
  const store = memStore();
  const c = await challenge(store);
  const fc: AccessKeyView = { permission: { kind: "FunctionCall", receiverId: "snacc-v001.testnet", methodNames: [], allowance: null }, nonce: 1n, blockHash: "h" };
  const r = await handleVerify(verifyBody(c), deps(store, { viewAccessKey: async () => fc }));
  assert.equal(r.status, 403);
  assert.equal(err(r), "not_full_access_key");
  assert.equal(err(await handleVerify(verifyBody(c), deps(store, { viewAccessKey: async () => null }))), "access_key_not_found");
  const down = await handleVerify(verifyBody(c), deps(store, { viewAccessKey: async () => Promise.reject(new Error("down")) }));
  assert.equal(down.status, 503);
  assert.equal(err(down), "rpc_unavailable");
  // none of the rejected attempts consumed the nonce
  assert.equal(store.nonces.get(c.nonce)?.used_at, null);
  assert.equal((await handleVerify(verifyBody(c), deps(store))).status, 200);
});

test("verify: concurrent verifies with the same nonce -> exactly one session", async () => {
  const store = memStore();
  const c = await challenge(store);
  const [a, b] = await Promise.all([handleVerify(verifyBody(c), deps(store)), handleVerify(verifyBody(c), deps(store))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 401]);
});

test("verify: custom email domain (SNACC_AUTH_EMAIL_DOMAIN)", async () => {
  const store = memStore();
  const c = await challenge(store);
  await handleVerify(verifyBody(c), deps(store, { emailDomain: "example.org" }));
  assert.match([...store.users.keys()][0] ?? "", /^near-[0-9a-f]{24}@example\.org$/);
});

test("http helpers: CORS allow-list, preflight, bearer token, safeEqual", () => {
  assert.equal(corsHeaders("https://snacc-nu.vercel.app")["Access-Control-Allow-Origin"], "https://snacc-nu.vercel.app");
  assert.equal(corsHeaders("http://localhost:5173")["Access-Control-Allow-Origin"], "http://localhost:5173");
  assert.equal(corsHeaders("http://localhost:4173")["Access-Control-Allow-Origin"], "http://localhost:4173");
  assert.equal(corsHeaders("https://evil.example")["Access-Control-Allow-Origin"], undefined);
  const pre = preflight(new Request("https://x/near-auth/verify", { method: "OPTIONS", headers: { origin: "http://localhost:5173" } }));
  assert.equal(pre?.status, 204);
  assert.equal(pre?.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.equal(preflight(new Request("https://x/near-auth/verify", { method: "POST" })), null);
  assert.equal(bearerToken(new Request("https://x", { headers: { authorization: "Bearer abc.def" } })), "abc.def");
  assert.equal(bearerToken(new Request("https://x")), null);
  assert.equal(safeEqual("secret", "secret"), true);
  assert.equal(safeEqual("secret", "secreT"), false);
  assert.equal(safeEqual("secret", "secret2"), false);
});
