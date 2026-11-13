// UI-160: Web Push. RFC 8291 encryption against the RFC's own vector (Appendix A / section 5), RFC 8292 VAPID JWT against the
// RFC's example token, endpoint/subscription validation, subscribe/unsubscribe handlers, payloads and dispatch planning.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PLAINTEXT_BYTES,
  b64uDecode,
  b64uEncode,
  encryptWebPush,
  generateVapidKeys,
  getOrCreateVapid,
  sendWebPush,
  signVapidJwt,
  vapidAuthorization,
  verifyVapidJwt,
  type VapidKeys,
  type VapidStore,
} from "../supabase/functions/_shared/webpush.js";
import {
  DISPATCH_MAX_AGE_MS,
  MAX_FAILURES,
  MAX_SUBSCRIPTIONS_PER_USER,
  buildPayload,
  handleSubscribe,
  handleUnsubscribe,
  isAllowedPushEndpoint,
  parseSubscription,
  planDispatch,
  planOutcomes,
  pushUrlFor,
  runPool,
  shortUserAgent,
  type DispatchNotification,
  type DispatchSub,
  type PushRow,
  type PushStore,
} from "../supabase/functions/_shared/push.js";

const b64u = (s: string): Uint8Array => {
  const d = b64uDecode(s);
  assert.ok(d, `bad base64url: ${s}`);
  return d;
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const subtle = globalThis.crypto.subtle;

// ---- RFC 8291 section 5 / Appendix A ---------------------------------------------------------------
const RFC8291 = {
  plaintext: "When I grow up, I want to be a watermelon",
  authSecret: "BTBZMqHH6r4Tts7J_aSIgg",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  message: [
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT",
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  ].join(""),
};

/** Independent receiver: RFC 8291 section 3.4 written with explicit HMACs (not the HKDF call the sender uses). */
async function decryptAsUserAgent(message: Uint8Array, uaPrivateD: string, uaPublic: string, authSecret: string): Promise<Uint8Array> {
  const hmac = async (key: Uint8Array, data: Uint8Array) => {
    const k = await subtle.importKey("raw", key.slice().buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return new Uint8Array(await subtle.sign("HMAC", k, data.slice().buffer as ArrayBuffer));
  };
  const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]));
  const salt = message.slice(0, 16);
  const idlen = message[20] as number;
  const asPublic = message.slice(21, 21 + idlen);
  const cipher = message.slice(21 + idlen);
  const pub = b64u(uaPublic);
  const priv = await subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), d: uaPrivateD },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const asKey = await subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await subtle.deriveBits({ name: "ECDH", public: asKey }, priv, 256));
  const prkKey = await hmac(b64u(authSecret), ecdh);
  const ikm = await hmac(prkKey, cat(utf8("WebPush: info\0"), pub, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(utf8("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(utf8("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const aes = await subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aes, cipher));
  assert.equal(plain[plain.length - 1], 0x02, "padding delimiter");
  return plain.slice(0, -1);
}

test("webpush: base64url round trips and rejects junk", () => {
  assert.equal(b64uEncode(new Uint8Array([251, 255, 254])), "-__-");
  assert.deepEqual([...b64u("-__-")], [251, 255, 254]);
  assert.deepEqual([...b64u("AQI=")], [1, 2]);
  assert.equal(b64uDecode("a+b/"), null);
  assert.equal(b64uDecode("a"), null);
  assert.equal(b64uDecode("ab cd"), null);
});

test("RFC 8291 Appendix A: encryption reproduces the published message byte for byte", async () => {
  const body = await encryptWebPush(utf8(RFC8291.plaintext), b64u(RFC8291.uaPublic), b64u(RFC8291.authSecret), {
    salt: b64u(RFC8291.salt),
    senderKey: { publicKey: b64u(RFC8291.asPublic), d: b64u(RFC8291.asPrivate) },
  });
  assert.equal(b64uEncode(body), RFC8291.message);
  // 86-byte header + 41 plaintext + 1 delimiter + 16 tag. (The RFC's example prints "Content-Length: 145", a known
  // slip: the message it shows, which we match exactly above, is 144 octets.)
  assert.equal(body.length, 144);
});

test("RFC 8291: a random ephemeral key and salt decrypt to the plaintext at the user agent", async () => {
  const text = JSON.stringify({ title: "Snacc #7 is starving", body: "Feed it now.", url: "/app?feed=7", tag: "snacc-1" });
  const a = await encryptWebPush(utf8(text), b64u(RFC8291.uaPublic), b64u(RFC8291.authSecret));
  const b = await encryptWebPush(utf8(text), b64u(RFC8291.uaPublic), b64u(RFC8291.authSecret));
  assert.notEqual(b64uEncode(a), b64uEncode(b), "fresh salt and key per message");
  for (const m of [a, b]) {
    assert.equal(new TextDecoder().decode(await decryptAsUserAgent(m, RFC8291.uaPrivate, RFC8291.uaPublic, RFC8291.authSecret)), text);
    assert.equal(m[20], 65, "keyid length");
    assert.equal(m[21], 0x04, "uncompressed sender key");
    assert.deepEqual([...m.slice(16, 20)], [0, 0, 16, 0], "record size 4096");
  }
});

test("RFC 8291: refuses oversize payloads, bad auth secrets and off-curve receiver keys", async () => {
  const ua = b64u(RFC8291.uaPublic);
  const auth = b64u(RFC8291.authSecret);
  await assert.rejects(() => encryptWebPush(new Uint8Array(MAX_PLAINTEXT_BYTES + 1), ua, auth), /too large/);
  await encryptWebPush(new Uint8Array(MAX_PLAINTEXT_BYTES), ua, auth); // the largest that fits still encrypts
  await assert.rejects(() => encryptWebPush(utf8("x"), ua, new Uint8Array(15)), /auth secret/);
  const offCurve = ua.slice();
  offCurve[64] = (offCurve[64] as number) ^ 1;
  await assert.rejects(() => encryptWebPush(utf8("x"), offCurve, auth), /not a valid P-256/);
});

// ---- RFC 8292 ----------------------------------------------------------------------------------------
const RFC8292 = {
  jwt: [
    "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9.eyJhdWQiOiJodHRwczovL3",
    "B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1ha",
    "Wx0bzpwdXNoQGV4YW1wbGUuY29tIn0.i3CYb7t4xfxCDquptFOepC9GAu_H",
    "LGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA",
  ].join(""),
  k: "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs",
  exp: 1453523768,
};

test("RFC 8292: the example JWT verifies with the example public key", async () => {
  assert.deepEqual(await verifyVapidJwt(RFC8292.jwt, RFC8292.k), { aud: "https://push.example.net", exp: RFC8292.exp, sub: "mailto:push@example.com" });
  assert.equal(await verifyVapidJwt(RFC8292.jwt, RFC8292.k, RFC8292.exp - 10) !== null, true, "still valid before exp");
  assert.equal(await verifyVapidJwt(RFC8292.jwt, RFC8292.k, RFC8292.exp + 1), null, "expired");
  const [h, c, s] = RFC8292.jwt.split(".") as [string, string, string];
  const tamperedClaims = b64uEncode(utf8(JSON.stringify({ aud: "https://evil.example", exp: RFC8292.exp, sub: "mailto:push@example.com" })));
  assert.equal(await verifyVapidJwt(`${h}.${tamperedClaims}.${s}`, RFC8292.k), null, "claims tampered");
  assert.equal(await verifyVapidJwt(`${h}.${c}.${s.slice(0, -2)}AA`, RFC8292.k), null, "signature tampered");
});

test("VAPID: a generated key signs a JWT with the RFC header and claim layout that verifies", async () => {
  const keys = await generateVapidKeys();
  assert.equal(keys.publicKey.length, 87);
  assert.equal(b64u(keys.publicKey)[0], 0x04);
  assert.deepEqual(Object.keys(keys.privateJwk).sort(), ["crv", "d", "kty", "x", "y"]);

  const jwt = await signVapidJwt({ audience: "https://push.example.net", subject: "mailto:push@example.com", nowSec: RFC8292.exp - 12 * 3600 }, keys.privateJwk);
  const [h, c, s] = jwt.split(".") as [string, string, string];
  const [rh, rc] = RFC8292.jwt.split(".") as [string, string];
  assert.equal(h, rh, "header is exactly {typ:JWT,alg:ES256}");
  assert.equal(c, rc, "claims aud, exp, sub in the RFC order");
  assert.equal(b64u(s).length, 64, "raw r||s signature");

  assert.deepEqual(await verifyVapidJwt(jwt, keys.publicKey, RFC8292.exp - 3600), { aud: "https://push.example.net", exp: RFC8292.exp, sub: "mailto:push@example.com" });
  const other = await generateVapidKeys();
  assert.equal(await verifyVapidJwt(jwt, other.publicKey), null, "a different key does not verify");
  assert.equal(await verifyVapidJwt(jwt, keys.publicKey, RFC8292.exp + 1), null, "expired");
});

test("VAPID: expiry stays within 24 hours and the Authorization header uses the vapid scheme", async () => {
  const keys = await generateVapidKeys();
  const now = 1_800_000_000;
  const jwt = await signVapidJwt({ audience: "https://fcm.googleapis.com", subject: "https://snacc-nu.vercel.app", nowSec: now }, keys.privateJwk);
  const claims = await verifyVapidJwt(jwt, keys.publicKey, now);
  assert.ok(claims);
  assert.ok(claims.exp - now <= 24 * 3600 && claims.exp - now > 0);
  assert.equal(vapidAuthorization(jwt, keys.publicKey), `vapid t=${jwt}, k=${keys.publicKey}`);
});

test("VAPID key lifecycle: generated once on first use, the stored key wins a race", async () => {
  let stored: VapidKeys | null = null;
  let generated = 0;
  const store: VapidStore = {
    read: async () => stored,
    insertIfAbsent: async (k) => {
      stored ??= k; // ON CONFLICT DO NOTHING
    },
  };
  const generate = async () => {
    generated++;
    return generateVapidKeys();
  };
  const first = await getOrCreateVapid(store, generate);
  const second = await getOrCreateVapid(store, generate);
  assert.equal(generated, 1);
  assert.equal(first.publicKey, second.publicKey);

  // Two first calls interleave: both generate, only one insert wins, both return the winner.
  stored = null;
  generated = 0;
  const [a, b] = await Promise.all([getOrCreateVapid(store, generate), getOrCreateVapid(store, generate)]);
  assert.equal(a.publicKey, b.publicKey);
  assert.equal(a.publicKey, (stored as VapidKeys | null)?.publicKey);

  await assert.rejects(() => getOrCreateVapid({ read: async () => null, insertIfAbsent: async () => undefined }, generate), /not stored/);
});

// ---- sending -------------------------------------------------------------------------------------------
const target = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret };

test("sendWebPush: posts the encrypted body with VAPID, TTL and aes128gcm headers", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchFn = async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(null, { status: 201 });
  };
  const payload = JSON.stringify({ title: "t", body: "b", url: "/app", tag: "snacc-9" });
  const out = await sendWebPush(target, payload, { authorization: "vapid t=x, k=y", ttl: 600, fetchFn });
  assert.deepEqual(out, { kind: "ok", status: 201 });
  assert.ok(seen);
  const { url, init } = seen as { url: string; init: RequestInit };
  assert.equal(url, target.endpoint);
  assert.equal(init.method, "POST");
  assert.equal(init.redirect, "manual");
  const h = init.headers as Record<string, string>;
  assert.equal(h["Authorization"], "vapid t=x, k=y");
  assert.equal(h["Content-Encoding"], "aes128gcm");
  assert.equal(h["TTL"], "600");
  assert.equal(h["Urgency"], "normal");
  const plain = await decryptAsUserAgent(new Uint8Array(init.body as ArrayBuffer), RFC8291.uaPrivate, RFC8291.uaPublic, RFC8291.authSecret);
  assert.equal(new TextDecoder().decode(plain), payload);
});

test("sendWebPush: maps push service answers to ok / gone / error and never throws", async () => {
  const run = (fetchFn: (u: string, i: RequestInit) => Promise<Response>, t = target) => sendWebPush(t, "{}", { authorization: "a", fetchFn });
  assert.equal((await run(async () => new Response(null, { status: 202 }))).kind, "ok");
  assert.deepEqual(await run(async () => new Response(null, { status: 410 })), { kind: "gone", status: 410 });
  assert.deepEqual(await run(async () => new Response(null, { status: 404 })), { kind: "gone", status: 404 });
  assert.deepEqual(await run(async () => new Response(null, { status: 429 })), { kind: "error", status: 429, message: "push service answered 429" });
  assert.deepEqual(await run(async () => new Response(null, { status: 403 })), { kind: "error", status: 403, message: "push service answered 403" });
  assert.equal((await run(async () => new Response(null, { status: 302 }))).kind, "error", "redirects are never followed");
  const down = await run(async () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(down, { kind: "error", status: null, message: "push service unreachable" });
  const timeout = await run(async () => {
    throw Object.assign(new Error("aborted"), { name: "AbortError" });
  });
  assert.deepEqual(timeout, { kind: "error", status: null, message: "push service timed out" });
  const badKeys = await run(async () => new Response(null, { status: 201 }), { ...target, p256dh: "not base64!" });
  assert.equal(badKeys.kind, "error");
  const offCurve = await run(async () => new Response(null, { status: 201 }), { ...target, p256dh: b64uEncode(new Uint8Array(65).fill(4)) });
  assert.equal(offCurve.kind, "error");
});

// ---- endpoint validation -----------------------------------------------------------------------------
test("isAllowedPushEndpoint: known push services only, https, no userinfo, port or tricks", () => {
  for (const good of [
    "https://fcm.googleapis.com/fcm/send/dX3q:APA91bH",
    "https://fcm.googleapis.com/wp/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/gAAAAA",
    "https://a.push.services.mozilla.com/wpush/v1/x",
    "https://web.push.apple.com/QGzNL4V9",
    "https://api.development.push.apple.com/3/device/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAD",
  ]) {
    assert.equal(isAllowedPushEndpoint(good), true, good);
  }
  for (const bad of [
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://example.com/push/abc",
    "https://fcm.googleapis.com.evil.com/fcm/send/abc",
    "https://evil.com/https://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com@evil.com/fcm/send/abc",
    "https://user:pw@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://fcm.googleapis.com./fcm/send/abc",
    "https://fcm.googleapis.com/fcm/send/abc#frag",
    "https://fcm.googleapis.com/",
    "https://fcm.googleapis.com",
    "https://evilnotify.windows.com/w/token",
    "https://notify.windows.com/w/token",
    "https://push.services.mozilla.com/x/y/z",
    "https://127.0.0.1/fcm/send/abc",
    "https://[::1]/fcm/send/abc",
    "https://localhost/fcm/send/abc",
    "https://fcm.googleapis.com/fcm/send/with space",
    "https://fcm.googleapis.com/" + "a".repeat(2100),
    "javascript:alert(1)",
    "file:///etc/passwd",
    "",
    "https://",
  ]) {
    assert.equal(isAllowedPushEndpoint(bad), false, bad.slice(0, 80));
  }
  for (const nope of [null, undefined, 42, {}, ["https://fcm.googleapis.com/fcm/send/abc"]]) assert.equal(isAllowedPushEndpoint(nope), false);
});

test("parseSubscription: needs a valid endpoint, an on-curve p256dh and a 16-byte auth", async () => {
  const good = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", expirationTime: null, keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret } };
  assert.deepEqual(await parseSubscription(good), { endpoint: good.endpoint, p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret });
  // padded base64url is normalised to the canonical unpadded form the table constraint expects
  assert.deepEqual(await parseSubscription({ ...good, keys: { p256dh: RFC8291.uaPublic, auth: `${RFC8291.authSecret}==` } }), {
    endpoint: good.endpoint,
    p256dh: RFC8291.uaPublic,
    auth: RFC8291.authSecret,
  });
  const err = async (body: Record<string, unknown> | null) => (await parseSubscription(body)) as { status: number; body: { error: string } };
  assert.equal((await err(null)).body.error, "bad_request");
  assert.equal((await err({ ...good, endpoint: "https://evil.example/x/y" })).body.error, "invalid_endpoint");
  assert.equal((await err({ endpoint: good.endpoint })).body.error, "invalid_keys");
  assert.equal((await err({ ...good, keys: [] })).body.error, "invalid_keys");
  assert.equal((await err({ ...good, keys: { p256dh: RFC8291.uaPublic, auth: "AAAA" } })).body.error, "invalid_keys");
  assert.equal((await err({ ...good, keys: { p256dh: "AAAA", auth: RFC8291.authSecret } })).body.error, "invalid_keys");
  const offCurve = b64uEncode(new Uint8Array(65).fill(4));
  assert.equal((await err({ ...good, keys: { p256dh: offCurve, auth: RFC8291.authSecret } })).status, 400);
  assert.equal((await err({ ...good, keys: { p256dh: 7, auth: 8 } })).body.error, "invalid_keys");
});

// ---- subscribe / unsubscribe ---------------------------------------------------------------------------
function memoryStore(): PushStore & { rows: PushRow[] } {
  const rows: PushRow[] = [];
  return {
    rows,
    countOthers: async (userId, except) => rows.filter((r) => r.user_id === userId && r.endpoint !== except).length,
    upsert: async (row) => {
      const i = rows.findIndex((r) => r.endpoint === row.endpoint);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
    },
    deleteOwn: async (userId, endpoint) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]?.user_id === userId && rows[i]?.endpoint === endpoint) rows.splice(i, 1);
      return before - rows.length;
    },
  };
}
const sub = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/dev-${n}`, keys: { p256dh: RFC8291.uaPublic, auth: RFC8291.authSecret } });

test("handleSubscribe: stores the canonical subscription with a short user agent, 201", async () => {
  const store = memoryStore();
  const r = await handleSubscribe("u1", sub(1), `Mozilla/5.0 ${"x".repeat(300)}\n`, store);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { subscribed: true });
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0]?.user_id, "u1");
  assert.equal(store.rows[0]?.endpoint, sub(1).endpoint);
  assert.ok((store.rows[0]?.user_agent ?? "").length <= 120);
  assert.equal(shortUserAgent(null), null);
  assert.equal(shortUserAgent("  \n "), null);
  assert.equal(shortUserAgent("a\u0000b"), "a b");
});

test("handleSubscribe: re-subscribing the same endpoint is idempotent; a device can move to another player", async () => {
  const store = memoryStore();
  await handleSubscribe("u1", sub(1), null, store);
  await handleSubscribe("u1", sub(1), null, store);
  assert.equal(store.rows.length, 1);
  await handleSubscribe("u2", sub(1), null, store); // same browser, different signed-in player: the row moves
  assert.equal(store.rows.length, 1);
  assert.equal(store.rows[0]?.user_id, "u2");
});

test("handleSubscribe: rejects bad subscriptions and caps devices per player", async () => {
  const store = memoryStore();
  assert.equal((await handleSubscribe("u1", { endpoint: "https://evil.example/a/b", keys: sub(1).keys }, null, store)).status, 400);
  assert.equal((await handleSubscribe("u1", null, null, store)).status, 400);
  assert.equal(store.rows.length, 0);
  for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER; i++) assert.equal((await handleSubscribe("u1", sub(i), null, store)).status, 201);
  const over = await handleSubscribe("u1", sub(99), null, store);
  assert.equal(over.status, 409);
  assert.equal((over.body as { error: string }).error, "too_many_subscriptions");
  assert.equal((await handleSubscribe("u1", sub(3), null, store)).status, 201, "an existing device can still refresh");
  assert.equal((await handleSubscribe("u2", sub(99), null, store)).status, 201, "other players are not affected");
});

test("handleUnsubscribe: removes only the caller's own row and is idempotent", async () => {
  const store = memoryStore();
  await handleSubscribe("u1", sub(1), null, store);
  const other = await handleUnsubscribe("u2", { endpoint: sub(1).endpoint }, store);
  assert.deepEqual(other.body, { unsubscribed: true, removed: 0 });
  assert.equal(store.rows.length, 1);
  const own = await handleUnsubscribe("u1", { endpoint: sub(1).endpoint }, store);
  assert.deepEqual(own.body, { unsubscribed: true, removed: 1 });
  assert.deepEqual((await handleUnsubscribe("u1", { endpoint: sub(1).endpoint }, store)).body, { unsubscribed: true, removed: 0 });
  assert.equal((await handleUnsubscribe("u1", {}, store)).status, 400);
  assert.equal((await handleUnsubscribe("u1", null, store)).status, 400);
  assert.equal((await handleUnsubscribe("u1", { endpoint: "x" }, store)).status, 400);
});

// ---- payloads ---------------------------------------------------------------------------------------------
const note = (over: Partial<DispatchNotification> = {}): DispatchNotification => ({
  id: 1,
  user_id: "u1",
  kind: "starving",
  strain_id: 7,
  title: "Snacc #7 is starving",
  body: "Vitality is 0.",
  created_at: "2026-11-13T12:00:00Z",
  ...over,
});

test("pushUrlFor: hungry Snaccs deep-link to the feed window, everything else opens the app", () => {
  assert.equal(pushUrlFor({ kind: "starving", strain_id: 7 }), "/app?feed=7");
  assert.equal(pushUrlFor({ kind: "distressed", strain_id: "12" }), "/app?feed=12");
  assert.equal(pushUrlFor({ kind: "starving", strain_id: 0 }), "/app?feed=0");
  for (const kind of ["lost", "dividend", "starter", "system"]) assert.equal(pushUrlFor({ kind, strain_id: 7 }), "/app");
  assert.equal(pushUrlFor({ kind: "starving", strain_id: null }), "/app");
  assert.equal(pushUrlFor({ kind: "starving", strain_id: -1 }), "/app");
  assert.equal(pushUrlFor({ kind: "starving", strain_id: "7&x=1" }), "/app");
  assert.equal(pushUrlFor({ kind: "starving", strain_id: 1e12 }), "/app");
});

test("buildPayload: {title, body, url, tag} with bounded sizes, tag matches the in-page alert", async () => {
  assert.deepEqual(buildPayload(note()), { title: "Snacc #7 is starving", body: "Vitality is 0.", url: "/app?feed=7", tag: "snacc-1" });
  assert.deepEqual(buildPayload(note({ id: 42, kind: "system", strain_id: null, title: "Maintenance", body: null })), {
    title: "Maintenance",
    body: "",
    url: "/app",
    tag: "snacc-42",
  });
  const big = buildPayload(note({ title: "t".repeat(500), body: "b".repeat(900) }));
  assert.equal(big.title.length, 120);
  assert.equal(big.body.length, 200);
  // worst case: four-byte characters everywhere still fits one record
  const worst = buildPayload(note({ title: "\u{1F95E}".repeat(120), body: "\u{1F95E}".repeat(200) }));
  assert.ok(utf8(JSON.stringify(worst)).length < MAX_PLAINTEXT_BYTES);
  await encryptWebPush(utf8(JSON.stringify(worst)), b64u(RFC8291.uaPublic), b64u(RFC8291.authSecret));
});

// ---- dispatch planning ------------------------------------------------------------------------------------
const NOW = Date.parse("2026-11-13T12:05:00Z");
const dsub = (id: number, userId: string, over: Partial<DispatchSub> = {}): DispatchSub => ({
  id,
  user_id: userId,
  endpoint: `https://fcm.googleapis.com/fcm/send/s${id}`,
  p256dh: RFC8291.uaPublic,
  auth: RFC8291.authSecret,
  failures: 0,
  ...over,
});
const plan = (notifications: DispatchNotification[], subs: DispatchSub[], maxSends = 100) =>
  planDispatch({ notifications, subs, nowMs: NOW, maxAgeMs: DISPATCH_MAX_AGE_MS, maxSends });

test("planDispatch: one job per device of the player, payload per notification", () => {
  const p = plan([note({ id: 1 }), note({ id: 2, user_id: "u2", kind: "system", strain_id: null, title: "Hi" })], [dsub(10, "u1"), dsub(11, "u1"), dsub(12, "u2")]);
  assert.deepEqual(p.claimIds, [1, 2]);
  assert.deepEqual(p.jobs.map((j) => [j.notificationId, j.sub.id]), [[1, 10], [1, 11], [2, 12]]);
  assert.equal(p.jobs[0]?.payload.url, "/app?feed=7");
  assert.equal(p.jobs[2]?.payload.url, "/app");
  assert.deepEqual(p.skipped, { noSubscription: 0, stale: 0 });
  assert.equal(p.deferred, 0);
});

test("planDispatch: no devices and stale notifications are claimed without a send", () => {
  const p = plan(
    [note({ id: 1, user_id: "nobody" }), note({ id: 2, created_at: "2026-11-13T11:00:00Z" }), note({ id: 3, created_at: "not a date" }), note({ id: 4 })],
    [dsub(10, "u1")],
  );
  assert.deepEqual(p.claimIds, [1, 2, 3, 4]);
  assert.deepEqual(p.jobs.map((j) => j.notificationId), [4]);
  assert.deepEqual(p.skipped, { noSubscription: 1, stale: 2 });
});

test("planDispatch: devices with an off-list endpoint or too many failures are never used", () => {
  const p = plan(
    [note({ id: 1 })],
    [dsub(10, "u1", { endpoint: "https://internal.example/hook" }), dsub(11, "u1", { failures: MAX_FAILURES }), dsub(12, "u1", { failures: MAX_FAILURES - 1 })],
  );
  assert.deepEqual(p.jobs.map((j) => j.sub.id), [12]);
});

test("planDispatch: the send cap defers whole notifications, keeps order, still claims no-send ones", () => {
  const subs = [dsub(1, "u1"), dsub(2, "u1"), dsub(3, "u2"), dsub(4, "u2"), dsub(5, "u3")];
  const notifications = [
    note({ id: 1, user_id: "u1" }),
    note({ id: 2, user_id: "u2" }),
    note({ id: 3, user_id: "nobody" }),
    note({ id: 4, user_id: "u3" }),
    note({ id: 5, user_id: "nobody" }),
  ];
  const p = plan(notifications, subs, 3);
  assert.deepEqual(p.jobs.map((j) => j.notificationId), [1, 1]); // 2 sends so far, notification 2 would make it 4 > 3
  assert.deepEqual(p.claimIds, [1, 3, 5]);
  assert.equal(p.deferred, 2); // notifications 2 and 4
  const exact = plan(notifications.slice(0, 2), subs, 4);
  assert.deepEqual(exact.claimIds, [1, 2]);
  assert.equal(exact.deferred, 0);
  const huge = plan([note({ id: 1, user_id: "u1" })], subs, 1); // a single notification is never starved by a small cap
  assert.deepEqual(huge.claimIds, [1]);
  assert.equal(huge.jobs.length, 2);
});

test("planOutcomes: gone removes, success resets, other failures count and finally remove", () => {
  const a = dsub(1, "u1");
  const b = dsub(2, "u1", { failures: 3 });
  const c = dsub(3, "u2", { failures: MAX_FAILURES - 1 });
  const d = dsub(4, "u3");
  const e = dsub(5, "u4", { failures: 2 });
  const f = dsub(6, "u5", { failures: 1 });
  const ok = { kind: "ok", status: 201 } as const;
  const gone = { kind: "gone", status: 410 } as const;
  const err = { kind: "error", status: 500, message: "x" } as const;
  const out = planOutcomes([
    { sub: a, outcome: gone },
    { sub: b, outcome: err },
    { sub: c, outcome: err },
    { sub: d, outcome: ok },
    { sub: e, outcome: err },
    { sub: e, outcome: err }, // two failed sends in one run count once
    { sub: f, outcome: ok },
    { sub: f, outcome: err }, // delivered at least once this run: not a failure
    { sub: a, outcome: ok }, // gone wins over any other result for the same device
  ]);
  assert.deepEqual(out.remove.sort(), [1, 3]);
  assert.deepEqual(out.ok.sort(), [4, 6]);
  assert.deepEqual(out.failed.sort((x, y) => x.id - y.id), [
    { id: 2, failures: 4 },
    { id: 5, failures: 3 },
  ]);
  assert.deepEqual(planOutcomes([]), { remove: [], ok: [], failed: [] });
});

test("runPool: bounded concurrency, all items processed, stops starting new work when asked", async () => {
  let running = 0;
  let peak = 0;
  const results = await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 2));
    running--;
    return n * 2;
  });
  assert.equal(results.length, 10);
  assert.ok(peak <= 3 && peak >= 2, `peak ${peak}`);
  assert.deepEqual(results.sort((a, b) => a - b), [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);

  let started = 0;
  const partial = await runPool([1, 2, 3, 4, 5], 1, async (n) => {
    started++;
    return n;
  }, () => started >= 2);
  assert.deepEqual(partial, [1, 2]);
  assert.deepEqual(await runPool([], 4, async (n: number) => n), []);
});
