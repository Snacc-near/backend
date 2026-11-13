// OPS-127: telemetry batch validation, route generalisation and scrubbing (no PII may be stored).
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ITEMS, TELEMETRY_EVENTS, generaliseRoute, parseBatch, scrub } from "../supabase/functions/_shared/telemetry.js";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const ids = { deviceId: "0f8b6c1e-6a1d-4d1e-9a5b-2f4c8d7e9a10", sessionId: "s-1a2b3c4d5e6f" };

test("telemetry: routes are generalised, never carry ids or accounts", () => {
  assert.equal(generaliseRoute("/snacc/12"), "/snacc/:id");
  assert.equal(generaliseRoute("/p/alice.testnet"), "/p/:account");
  assert.equal(generaliseRoute("/app?feed=7#x"), "/app");
  assert.equal(generaliseRoute("/app/anything"), "/app");
  assert.equal(generaliseRoute("/"), "/");
  assert.equal(generaliseRoute("/privacy/"), "/privacy");
  assert.equal(generaliseRoute("/wp-admin"), "/other");
  assert.equal(generaliseRoute(42), "/other");
});

test("telemetry: scrub removes keys, tokens, emails, queries, accounts and hashes", () => {
  const dirty =
    "boom ed25519:3D4YudUahN1nawWogh8pAKSj92sUNMdbZGjn7kERKzYoTy8tnFQuwoGUC51DowKqorvkr2pytJSnwuSbsNVfqygr " +
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop " +
    "mail bob@example.com url https://x.io/a?token=abc&feed=3 acct alice.testnet " +
    "hash " + "a".repeat(64) + " tx 8ydFE4XjpwYbnrPUULjvtbqbqwU4PYSJ3rJyyVimu4TL";
  const s = scrub(dirty, 1000);
  for (const leaked of ["ed25519:3D4", "eyJhbGci", "bob@example.com", "token=abc", "alice.testnet", "a".repeat(64), "8ydFE4Xj"]) {
    assert.equal(s.includes(leaked), false, `leaked ${leaked}`);
  }
  assert.match(s, /\[key\].*\[jwt\].*\[email\].*token=\[x\].*\[account\].*\[hex\].*\[b58\]/);
  assert.equal(scrub("ab ".repeat(200), 300).length, 300);
  assert.equal(scrub("x".repeat(500), 300), "[b58]", "a long base58-looking run is treated as a hash");
});

test("telemetry: parseBatch keeps allow-listed events, drops the rest, cleans props", () => {
  const r = parseBatch(
    {
      ...ids,
      events: [
        { name: "page_view", route: "/snacc/5", ts: NOW - 1000, props: { from: "landing", n: 1.23456, ok: true, "Bad-Key": 1, obj: { a: 1 } } },
        { name: "not_an_event" },
        { name: "tx_succeeded", route: "/app", ts: NOW + 3 * 86_400_000, props: { method: "feed_strain", who: "bob.testnet" } },
      ],
      errors: [{ name: "TypeError", message: "x is undefined at alice.testnet", stack: "at f (https://snacc-nu.vercel.app/a.js?v=1:1:2)", route: "/app" }, { message: "" }],
    },
    NOW,
  );
  assert.ok(r);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rejected, 2);
  const [pv, tx, err] = r.rows;
  assert.equal(pv!.route, "/snacc/:id");
  assert.deepEqual(pv!.props, { from: "landing", n: 1.235, ok: true });
  assert.equal(tx!.client_at, new Date(NOW).toISOString(), "far-future client time falls back to server time");
  assert.equal(tx!.props.who, "[account]");
  assert.equal(err!.kind, "error");
  assert.equal(err!.message, "x is undefined at [account]");
  assert.equal(err!.stack?.includes("v=1"), false);
});

test("telemetry: ids are required and batches are capped", () => {
  assert.equal(parseBatch({ deviceId: "short", sessionId: ids.sessionId }, NOW), null);
  assert.equal(parseBatch({ deviceId: ids.deviceId }, NOW), null);
  assert.equal(parseBatch(null, NOW), null);
  const many = parseBatch({ ...ids, events: Array.from({ length: 30 }, () => ({ name: "page_view", route: "/" })) }, NOW);
  assert.equal(many!.rows.length, MAX_ITEMS);
  assert.equal(many!.rejected, 30 - MAX_ITEMS);
  assert.ok(TELEMETRY_EVENTS.includes("onboarding_done"));
});
