// Achievement/streak rules (mirrored by the SQL trigger + streaks_snacc view), notify-scan planning,
// the starter-pack handler and the minimal Transfer signer (pinned to a near-api-js 7.4.0 vector).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { ACHIEVEMENT_CODES, bestFeedStreak, computeAchievements, currentFeedStreak, utcDay } from "../supabase/functions/_shared/rules.js";
import {
  DEFAULT_PREFS,
  dedupeKey,
  missingFromListing,
  planScan,
  readOwnedStrains,
  readStrainOrNull,
  type StrainSnapshot,
} from "../supabase/functions/_shared/scan.js";
import { clientIp, handleStarterPack, hashClientIp, verifyTurnstile, type StarterStore } from "../supabase/functions/_shared/starter.js";
import {
  FaucetOutcomeUnknownError,
  STARTER_AMOUNT_YOCTO,
  parseNearSecretKey,
  serializeTransferTx,
  signTransferTx,
} from "../supabase/functions/_shared/near-tx.js";
import { NearRpcError } from "../supabase/functions/_shared/near-rpc.js";
import { base58Decode, base58Encode, base64Decode } from "../supabase/functions/_shared/nep413.js";
import type { PlannedNotification } from "../supabase/functions/_shared/scan.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 10, 23, 30); // 2026-11-10 23:30 UTC
const act = (method: string, ms: number) => ({ method, blockTimeMs: ms });

test("utcDay is UTC, not local time", () => {
  assert.equal(utcDay(T0), "2026-11-10");
  assert.equal(utcDay(T0 + 31 * 60_000), "2026-11-11");
});

test("streaks: best run and current run (today or yesterday counts)", () => {
  const feeds = [act("feed_strain", T0), act("feed_strain", T0 + 60_000), act("feed_strain", T0 + DAY), act("feed_strain", T0 + 2 * DAY), act("feed_strain", T0 + 4 * DAY)];
  assert.equal(bestFeedStreak(feeds), 3);
  assert.equal(bestFeedStreak([act("incubate_strain", T0)]), 0);
  assert.deepEqual(currentFeedStreak(feeds, T0 + 4 * DAY), { days: 1, lastFeedDay: "2026-11-14" });
  assert.deepEqual(currentFeedStreak(feeds.slice(0, 4), T0 + 3 * DAY), { days: 3, lastFeedDay: "2026-11-12" }); // yesterday
  assert.deepEqual(currentFeedStreak(feeds.slice(0, 4), T0 + 4 * DAY), { days: 0, lastFeedDay: "2026-11-12" }); // broken
  assert.deepEqual(currentFeedStreak([], T0), { days: 0, lastFeedDay: null });
});

test("achievements: every code and its threshold", () => {
  assert.deepEqual([...computeAchievements([])], []);
  assert.deepEqual([...computeAchievements([act("incubate_strain", T0)])], ["first_hatch"]);
  assert.deepEqual([...computeAchievements([act("feed_strain", T0)])], ["first_feed"]);
  const tenFeedsOneDay = Array.from({ length: 10 }, (_, i) => act("feed_strain", T0 - i * 1000));
  assert.deepEqual([...computeAchievements(tenFeedsOneDay)].sort(), ["feeds_10", "first_feed"]);
  const sevenDays = Array.from({ length: 7 }, (_, i) => act("feed_strain", T0 + i * DAY));
  assert.deepEqual([...computeAchievements(sevenDays)].sort(), ["first_feed", "streak_3", "streak_7"]);
  assert.deepEqual([...computeAchievements([act("adopt", T0)])], ["rescuer"]);
  assert.deepEqual([...computeAchievements([act("nft_transfer", T0)])], ["gifter"]);
  const colony = [act("incubate_strain", T0), act("divide_strain", T0), act("divide_strain", T0), act("divide_strain", T0), act("divide_strain", T0)];
  assert.deepEqual([...computeAchievements(colony)].sort(), ["colony_5", "first_hatch"]);
  assert.equal(computeAchievements(colony.slice(0, 4)).has("colony_5"), false);
  assert.deepEqual([...computeAchievements([act("splice_strains", T0)])], []);
});

test("achievements: recruiter is a listed code but never derived from the player's own activity (UI-158)", () => {
  assert.ok((ACHIEVEMENT_CODES as readonly string[]).includes("recruiter"));
  // The original eight codes stay in place; recruiter is appended.
  assert.deepEqual(
    [...ACHIEVEMENT_CODES],
    ["first_hatch", "first_feed", "feeds_10", "streak_3", "streak_7", "rescuer", "gifter", "colony_5", "recruiter"],
  );
  // Whatever a player does themselves, the badge depends on someone else's first hatch (referrals_snacc), so it is
  // only ever awarded by the SQL trigger and never by computeAchievements.
  const everything = ["incubate_strain", "feed_strain", "adopt", "nft_transfer", "divide_strain"].map((m) => act(m, T0));
  assert.equal(computeAchievements(everything).has("recruiter" as never), false);
});

// ---- notify-scan ----
const ACC = "alice.testnet";
const UID = "00000000-0000-4000-8000-000000000001";
const strain = (id: string, effectiveVitality: number, status = effectiveVitality > 0 && effectiveVitality <= 2000 ? "Distressed" : "Active", ownerId = ACC): StrainSnapshot => ({
  strainId: id,
  ownerId,
  status,
  effectiveVitality,
});

test("planScan: starving (0) and distressed (1..2000), dedupe key per kind/strain/UTC day", () => {
  const p = planScan({ userId: UID, accountId: ACC, current: [strain("1", 0), strain("2", 1), strain("3", 2000), strain("4", 2001)], previous: null, recheck: {}, prefs: DEFAULT_PREFS, nowMs: T0 });
  assert.deepEqual(
    p.notifications.map((n) => [n.kind, n.strain_id, n.dedupe_key]),
    [
      ["starving", "1", "starving:1:2026-11-10"],
      ["distressed", "2", "distressed:2:2026-11-10"],
      ["distressed", "3", "distressed:3:2026-11-10"],
    ],
  );
  assert.deepEqual(p.memory, { "1": "Active", "2": "Distressed", "3": "Distressed", "4": "Active" });
  assert.equal(dedupeKey("starving", "1", T0 + DAY), "starving:1:2026-11-11");
});

test("planScan: prefs filter kinds", () => {
  const p = planScan({ userId: UID, accountId: ACC, current: [strain("1", 0), strain("2", 5)], previous: null, recheck: {}, prefs: { ...DEFAULT_PREFS, starving: false }, nowMs: T0 });
  assert.deepEqual(p.notifications.map((n) => n.kind), ["distressed"]);
});

test("planScan: lost = transferred away, liquidated, spliced; first scan never reports lost", () => {
  const previous = { "1": "Active", "2": "Distressed", "3": "Active", "4": "Liquidated", "5": "Active" };
  const current = [strain("2", 0, "Liquidated"), strain("3", 0, "SplicedBurned"), strain("4", 0, "Liquidated")];
  assert.deepEqual(missingFromListing(previous, current).sort(), ["1", "5"]);
  const p = planScan({
    userId: UID,
    accountId: ACC,
    current,
    previous,
    recheck: { "1": strain("1", 5000, "Active", "bob.testnet"), "5": strain("5", 5000) }, // 5 still ours (listing truncated)
    prefs: DEFAULT_PREFS,
    nowMs: T0,
  });
  assert.deepEqual(p.notifications.map((n) => [n.kind, n.strain_id]).sort(), [["lost", "1"], ["lost", "2"], ["lost", "3"]]);
  assert.equal(p.memory["5"], "Active");
  assert.equal(p.memory["1"], undefined);
  assert.equal(p.memory["4"], "Liquidated"); // already terminal before: no repeat
  assert.equal(planScan({ userId: UID, accountId: ACC, current, previous: null, recheck: {}, prefs: DEFAULT_PREFS, nowMs: T0 }).notifications.length, 0);
});

test("readOwnedStrains: pages nft_tokens_for_owner then get_strain; readStrainOrNull maps panics only", async () => {
  const calls: string[] = [];
  const view = (async (method: string, args: Record<string, unknown>) => {
    calls.push(`${method}:${JSON.stringify(args)}`);
    if (method === "nft_tokens_for_owner") {
      const from = Number(args["from_index"]);
      return Array.from({ length: Math.max(0, Math.min(2, 5 - from)) }, (_, i) => ({ token_id: String(from + i + 1) }));
    }
    const id = Number(args["strain_id"]);
    if (id === 99) throw new NearRpcError("rpc", "panic", "HANDLER_ERROR", "CONTRACT_EXECUTION_ERROR");
    if (id === 98) throw new NearRpcError("transport", "down");
    return { strain_id: id, owner_id: ACC, status: "Active", effective_vitality: id * 1000 };
  }) as <T>(method: string, args: unknown) => Promise<T>;
  const out = await readOwnedStrains(view, ACC, 2, 4);
  assert.deepEqual(out.map((s) => s.strainId), ["1", "2", "3", "4"]);
  assert.equal(out[2]?.effectiveVitality, 3000);
  assert.equal(calls.filter((c) => c.startsWith("nft_tokens_for_owner")).length, 2);
  assert.equal(await readStrainOrNull(view, "99"), null);
  await assert.rejects(readStrainOrNull(view, "98"), NearRpcError);
});

// ---- starter-pack ----
function memStarter(accounts: Record<string, string>, preClaims = 0, preIp: { hash: string; n: number } | null = null) {
  const claims = new Map<string, { tx_hash: string | null; created_at: string; ip_hash: string | null }>();
  for (let i = 0; i < preClaims; i++) claims.set(`filler${i}.testnet`, { tx_hash: "x", created_at: new Date(T0).toISOString(), ip_hash: null });
  for (let i = 0; i < (preIp?.n ?? 0); i++) claims.set(`ipfiller${i}.testnet`, { tx_hash: "x", created_at: new Date(T0).toISOString(), ip_hash: preIp!.hash });
  const notes: PlannedNotification[] = [];
  const store: StarterStore = {
    async nearAccountIdOf(u) {
      return accounts[u] ?? null;
    },
    async existingClaim(a) {
      return claims.get(a) ?? null;
    },
    async reserveClaim(row) {
      if (claims.has(row.near_account_id)) return false;
      claims.set(row.near_account_id, { tx_hash: null, created_at: new Date(T0).toISOString(), ip_hash: row.ip_hash });
      return true;
    },
    async claimsSince(iso) {
      return [...claims.values()].filter((c) => c.created_at >= iso).length;
    },
    async claimsFromIpSince(hash, iso) {
      return [...claims.values()].filter((c) => c.ip_hash === hash && c.created_at >= iso).length;
    },
    async releaseClaim(a) {
      claims.delete(a);
    },
    async completeClaim(a, tx) {
      const c = claims.get(a);
      if (c) c.tx_hash = tx;
    },
    async insertNotification(n) {
      notes.push(n);
    },
  };
  return { store, claims, notes };
}
const err = (r: { body: unknown }) => (r.body as { error: string }).error;

test("starter-pack: 503 not_configured when faucet secrets are missing", async () => {
  const { store } = memStarter({ [UID]: ACC });
  const r = await handleStarterPack(UID, { store, sendTransfer: null, viewAccount: async () => ({ amount: "0" }) });
  assert.equal(r.status, 503);
  assert.equal(err(r), "not_configured");
});

test("starter-pack: sends 0.3 NEAR once, records claim + starter notification", async () => {
  const { store, claims, notes } = memStarter({ [UID]: ACC });
  const sent: Array<[string, bigint]> = [];
  const deps = {
    store,
    now: () => T0,
    viewAccount: async () => ({ amount: "1000" }),
    sendTransfer: async (to: string, amt: bigint) => {
      sent.push([to, amt]);
      return "TxHash111";
    },
  };
  const r = await handleStarterPack(UID, deps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { claimed: true, txHash: "TxHash111", amountYocto: "300000000000000000000000" });
  assert.deepEqual(sent, [[ACC, STARTER_AMOUNT_YOCTO]]);
  assert.equal(claims.get(ACC)?.tx_hash, "TxHash111");
  assert.equal(notes[0]?.kind, "starter");
  assert.equal(notes[0]?.dedupe_key, `starter:${ACC}`);
  const again = await handleStarterPack(UID, deps);
  assert.equal(err(again), "already_claimed");
  assert.equal(sent.length, 1);
});

test("starter-pack: balance >= 0.3 NEAR, daily cap, failed transfer releases, unknown outcome keeps claim", async () => {
  const send = async () => "tx";
  const rich = memStarter({ [UID]: ACC });
  assert.equal(err(await handleStarterPack(UID, { store: rich.store, sendTransfer: send, viewAccount: async () => ({ amount: STARTER_AMOUNT_YOCTO.toString() }) })), "balance_sufficient");
  const unfunded = memStarter({ [UID]: "f".repeat(64) });
  assert.equal((await handleStarterPack(UID, { store: unfunded.store, sendTransfer: send, now: () => T0, viewAccount: async () => null })).status, 200);

  const capped = memStarter({ [UID]: ACC }, 100);
  const c = await handleStarterPack(UID, { store: capped.store, sendTransfer: send, now: () => T0, viewAccount: async () => ({ amount: "0" }) });
  assert.equal(c.status, 429);
  assert.equal(err(c), "daily_cap_reached");
  assert.equal(capped.claims.has(ACC), false);
  const almost = memStarter({ [UID]: ACC }, 99);
  assert.equal((await handleStarterPack(UID, { store: almost.store, sendTransfer: send, now: () => T0, viewAccount: async () => ({ amount: "0" }) })).status, 200);

  const broken = memStarter({ [UID]: ACC });
  const b = await handleStarterPack(UID, { store: broken.store, now: () => T0, viewAccount: async () => ({ amount: "0" }), sendTransfer: async () => Promise.reject(new Error("InvalidTxError")) });
  assert.equal(err(b), "transfer_failed");
  assert.equal(broken.claims.has(ACC), false);

  const lostAnswer = memStarter({ [UID]: ACC });
  const u = await handleStarterPack(UID, { store: lostAnswer.store, now: () => T0, viewAccount: async () => ({ amount: "0" }), sendTransfer: async () => Promise.reject(new FaucetOutcomeUnknownError("Hash9")) });
  assert.equal(err(u), "transfer_unknown");
  assert.equal(lostAnswer.claims.get(ACC)?.tx_hash, "Hash9");

  const noProfile = memStarter({});
  assert.equal(err(await handleStarterPack(UID, { store: noProfile.store, sendTransfer: send, viewAccount: async () => null })), "no_profile");
});

test("starter-pack SEC-119: per-IP daily cap, captcha gate, hashed IP only", async () => {
  const send = async () => "tx";
  const zero = async () => ({ amount: "0" });
  const ipHash = await hashClientIp("203.0.113.7", "k");
  assert.match(ipHash, /^[0-9a-f]{64}$/);
  assert.notEqual(ipHash, await hashClientIp("203.0.113.8", "k"));
  assert.notEqual(ipHash, await hashClientIp("203.0.113.7", "other-key"));
  assert.equal(ipHash.includes("203"), false);

  // 2 earlier claims from the same network: the 3rd is allowed and stores only the hash.
  const third = memStarter({ [UID]: ACC }, 0, { hash: ipHash, n: 2 });
  assert.equal((await handleStarterPack(UID, { store: third.store, sendTransfer: send, now: () => T0, viewAccount: zero, ipHash })).status, 200);
  assert.equal(third.claims.get(ACC)?.ip_hash, ipHash);
  // 3 earlier claims: the 4th is refused and its reservation released.
  const fourth = memStarter({ [UID]: ACC }, 0, { hash: ipHash, n: 3 });
  const r = await handleStarterPack(UID, { store: fourth.store, sendTransfer: send, now: () => T0, viewAccount: zero, ipHash });
  assert.equal(r.status, 429);
  assert.equal(err(r), "ip_cap_reached");
  assert.equal(fourth.claims.has(ACC), false);
  // Another network is not affected.
  const other = memStarter({ [UID]: ACC }, 0, { hash: ipHash, n: 3 });
  assert.equal((await handleStarterPack(UID, { store: other.store, sendTransfer: send, now: () => T0, viewAccount: zero, ipHash: await hashClientIp("198.51.100.1", "k") })).status, 200);

  // Captcha: failing check stops before any claim; passing check proceeds.
  const cap = memStarter({ [UID]: ACC });
  const denied = await handleStarterPack(UID, { store: cap.store, sendTransfer: send, now: () => T0, viewAccount: zero, ipHash, verifyCaptcha: async () => false });
  assert.equal(denied.status, 403);
  assert.equal(err(denied), "captcha_failed");
  assert.equal(cap.claims.size, 0);
  assert.equal((await handleStarterPack(UID, { store: cap.store, sendTransfer: send, now: () => T0, viewAccount: zero, ipHash, verifyCaptcha: async () => true })).status, 200);
});

test("starter-pack SEC-119: clientIp header order and Turnstile verify", async () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
  assert.equal(clientIp(h({ "x-forwarded-for": " 203.0.113.7 , 10.0.0.1" })), "203.0.113.7");
  assert.equal(clientIp(h({ "cf-connecting-ip": "198.51.100.2" })), "198.51.100.2");
  assert.equal(clientIp(h({})), "unknown");

  const calls: Array<{ url: string; body: string }> = [];
  const fake = (answer: unknown, status = 200) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body) });
      return new Response(JSON.stringify(answer), { status });
    }) as typeof fetch;
  assert.equal(await verifyTurnstile("s", "tok", "203.0.113.7", fake({ success: true })), true);
  assert.equal(calls[0]?.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.match(calls[0]?.body ?? "", /secret=s&response=tok&remoteip=203\.0\.113\.7/);
  assert.equal(await verifyTurnstile("s", "tok", "unknown", fake({ success: false })), false);
  assert.equal(await verifyTurnstile("s", "tok", "unknown", fake({ success: true }, 500)), false);
  assert.equal(await verifyTurnstile("s", null, "unknown", fake({ success: true })), false);
  const boom = (async () => Promise.reject(new Error("offline"))) as typeof fetch;
  assert.equal(await verifyTurnstile("s", "tok", "unknown", boom), false);
});

// ---- minimal Transfer signer vs near-api-js 7.4.0 ----
// Deterministic throwaway test key: seed = 0x01..0x20, never a real account key. The secret is
// assembled here (seed ‖ public key) so no private-key literal sits in the repository.
const TEST_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const TEST_PUB = "ed25519:9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj";
const VEC = {
  secret: `ed25519:${base58Encode(new Uint8Array([...TEST_SEED, ...(base58Decode(TEST_PUB.slice(8)) as Uint8Array)]))}`,
  pub: TEST_PUB,
  blockHash: "3AF7tiGGLWCLrbeieoHCzugDhwAmAnTCHXd6hdjaja14",
  encHex:
    "0e0000006661756365742e746573746e65740079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad04966479df0d86487000000d000000616c6963652e746573746e6574201590b9d19b63ae1e1ef172fb4a1f85144419fe4574762a2cfd58c9165791870100000003000080e3e0a35708873f000000000000",
  signedB64:
    "DgAAAGZhdWNldC50ZXN0bmV0AHm1Vi6P5lT5QHixEuipi6eQH4U65pW+1+DjkQutBJZked8NhkhwAAANAAAAYWxpY2UudGVzdG5ldCAVkLnRm2OuHh7xcvtKH4UURBn+RXR2Kiz9WMkWV5GHAQAAAAMAAIDj4KNXCIc/AAAAAAAAAGivxNDxD0byHVLvwkN3o+agUzUhWcsG1gAwvJ7r9kLzTv6ihx/iCZBHvZ7wG5mYGcfVr83b1OTqCFtAY4Q0Cwo=",
};

test("signer: Borsh layout and signed bytes match near-api-js; signature verifies with node:crypto", async () => {
  const key = await parseNearSecretKey(VEC.secret);
  assert.equal(key.publicKey, VEC.pub);
  const tx = {
    signerId: "faucet.testnet",
    publicKeyRaw: key.publicKeyRaw,
    nonce: 123456789012345n,
    receiverId: "alice.testnet",
    blockHash: base58Decode(VEC.blockHash) as Uint8Array,
    depositYocto: STARTER_AMOUNT_YOCTO,
  };
  assert.equal(Buffer.from(serializeTransferTx(tx)).toString("hex"), VEC.encHex);
  const signed = await signTransferTx(key, tx);
  assert.equal(signed.signedTxBase64, VEC.signedB64);
  const hash = createHash("sha256").update(Buffer.from(VEC.encHex, "hex")).digest();
  assert.equal(signed.txHash, base58Encode(hash));
  const sig = Buffer.from(base64Decode(signed.signedTxBase64) as Uint8Array).subarray(VEC.encHex.length / 2 + 1);
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key.publicKeyRaw)]);
  assert.equal(edVerify(null, hash, createPublicKey({ key: spki, format: "der", type: "spki" }), sig), true);
});

test("signer: 32-byte seed form accepted; mismatched/garbage keys rejected without echoing the key", async () => {
  const raw = base58Decode(VEC.secret.slice(8)) as Uint8Array;
  assert.equal((await parseNearSecretKey(`ed25519:${base58Encode(raw.subarray(0, 32))}`)).publicKey, VEC.pub);
  const tampered = Uint8Array.from(raw);
  tampered[63] = (tampered[63] ?? 0) ^ 1;
  const tamperedStr = `ed25519:${base58Encode(tampered)}`;
  await assert.rejects(parseNearSecretKey(tamperedStr), (e: unknown) => e instanceof Error && !e.message.includes(tamperedStr.slice(8, 20)));
  await assert.rejects(parseNearSecretKey("secp256k1:abc"));
  await assert.rejects(parseNearSecretKey("ed25519:abc"));
  assert.throws(() => serializeTransferTx({ signerId: "a", publicKeyRaw: new Uint8Array(31), nonce: 1n, receiverId: "b", blockHash: new Uint8Array(32), depositYocto: 1n }));
});
