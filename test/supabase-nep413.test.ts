// Web Crypto NEP-413 verifier used by the Supabase Edge Functions, checked against the node:crypto
// implementation in src/nep413.ts with the same vectors and an independent Borsh signer.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import * as node413 from "../src/nep413.js";
import {
  base58Decode,
  base58Encode,
  base64Decode,
  base64Encode,
  nep413Hash,
  parseEd25519PublicKey,
  verifyNep413,
} from "../supabase/functions/_shared/nep413.js";

// ---- independent signer (manual Borsh, same helper shape as test/evaluate.test.ts) ----
function bstr(s: string): Buffer {
  const b = Buffer.from(s);
  const l = Buffer.alloc(4);
  l.writeUInt32LE(b.length);
  return Buffer.concat([l, b]);
}
function nep413Sign(priv: KeyObject, message: string, nonce: Buffer, recipient: string): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  const ser = Buffer.concat([tag, bstr(message), nonce, bstr(recipient), Buffer.from([0])]);
  return edSign(null, createHash("sha256").update(ser).digest(), priv);
}
function newKey(): { priv: KeyObject; pubStr: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { priv: privateKey, pubStr: `ed25519:${base58Encode(x)}` };
}

const MSG = "Sign in to Snacc as alice.testnet";
const RECIPIENT = "snacc-nu.vercel.app";
const signer = newKey();

test("base58: vectors shared with src/nep413 + round trip", () => {
  assert.equal(new TextDecoder().decode(base58Decode("2NEpo7TZRRrLZSi2U") ?? new Uint8Array()), "Hello World!");
  assert.deepEqual([...(base58Decode("1112") as Uint8Array)], [0, 0, 0, 1]);
  assert.equal(base58Decode("0OIl"), null);
  assert.deepEqual([...(base58Decode("") as Uint8Array)], []);
  assert.equal(base58Encode(new TextEncoder().encode("Hello World!")), "2NEpo7TZRRrLZSi2U");
  assert.equal(base58Encode(new Uint8Array([0, 0, 0, 1])), "1112");
  for (let i = 0; i < 50; i++) {
    const b = randomBytes(i % 40);
    if (i % 7 === 0 && b.length > 1) b[0] = 0;
    const enc = base58Encode(b);
    assert.deepEqual(Buffer.from(base58Decode(enc) as Uint8Array), b);
    assert.deepEqual(Buffer.from(base58Decode(enc) as Uint8Array), node413.base58Decode(enc));
  }
});

test("parseEd25519PublicKey matches src/nep413", () => {
  assert.equal(parseEd25519PublicKey(signer.pubStr)?.length, 32);
  assert.deepEqual(Buffer.from(parseEd25519PublicKey(signer.pubStr) as Uint8Array), node413.parseEd25519PublicKey(signer.pubStr));
  assert.equal(parseEd25519PublicKey("secp256k1:abc"), null);
  assert.equal(parseEd25519PublicKey("ed25519:abc"), null);
  assert.equal(parseEd25519PublicKey("ed25519:0OIl"), null);
});

test("base64: standard, url-safe, unpadded; rejects junk", () => {
  const b = randomBytes(32);
  assert.deepEqual(Buffer.from(base64Decode(b.toString("base64")) as Uint8Array), b);
  assert.deepEqual(Buffer.from(base64Decode(b.toString("base64url")) as Uint8Array), b);
  assert.equal(base64Encode(b), b.toString("base64"));
  assert.equal(base64Decode("not base64!"), null);
  assert.equal(base64Decode("abcde"), null);
  assert.deepEqual([...(base64Decode("") as Uint8Array)], []);
});

test("nep413Hash equals src/nep413 hash (with and without callbackUrl)", async () => {
  const nonce = randomBytes(32);
  for (const callbackUrl of [null, "https://snacc-nu.vercel.app/cb"]) {
    const web = await nep413Hash({ message: MSG, nonce, recipient: RECIPIENT, callbackUrl });
    const nodeHash = node413.nep413Hash({ message: MSG, nonce, recipient: RECIPIENT, callbackUrl });
    assert.equal(Buffer.from(web).toString("hex"), nodeHash.toString("hex"));
  }
});

test("verifyNep413 (Web Crypto): valid signature passes", async () => {
  const nonce = randomBytes(32);
  const sig = nep413Sign(signer.priv, MSG, nonce, RECIPIENT);
  assert.equal(await verifyNep413(signer.pubStr, { message: MSG, nonce, recipient: RECIPIENT }, sig), true);
});

test("verifyNep413 (Web Crypto): tampered message, wrong recipient, wrong nonce, other key, junk", async () => {
  const nonce = randomBytes(32);
  const sig = nep413Sign(signer.priv, MSG, nonce, RECIPIENT);
  const v = (o: { pk?: string; message?: string; nonce?: Uint8Array; recipient?: string; sig?: Uint8Array }) =>
    verifyNep413(o.pk ?? signer.pubStr, { message: o.message ?? MSG, nonce: o.nonce ?? nonce, recipient: o.recipient ?? RECIPIENT }, o.sig ?? sig);
  assert.equal(await v({ message: "Sign in to Snacc as bob.testnet" }), false);
  assert.equal(await v({ recipient: "evil.example" }), false);
  assert.equal(await v({ nonce: randomBytes(32) }), false);
  assert.equal(await v({ pk: newKey().pubStr }), false);
  assert.equal(await v({ sig: Buffer.alloc(64, 1) }), false);
  assert.equal(await v({ sig: sig.subarray(0, 63) }), false);
  assert.equal(await v({ nonce: randomBytes(31) }), false);
  assert.equal(await v({ pk: "ed25519:abc" }), false);
  // signature produced over a different recipient (the evaluate endpoint's) must not pass here
  const other = nep413Sign(signer.priv, MSG, nonce, "snacc-evaluate");
  assert.equal(await v({ sig: other }), false);
});

test("Web Crypto verifier is equivalent to node:crypto verifier (src/nep413) on random cases", async () => {
  for (let i = 0; i < 40; i++) {
    const key = i % 5 === 0 ? newKey() : signer;
    const nonce = randomBytes(32);
    const message = `msg-${i}-${randomBytes(4).toString("hex")}`;
    let sig = nep413Sign(key.priv, message, nonce, RECIPIENT);
    if (i % 3 === 1) {
      sig = Buffer.from(sig);
      sig[i % 64] = (sig[i % 64] ?? 0) ^ 0x01;
    }
    const pk = i % 7 === 3 ? newKey().pubStr : key.pubStr;
    const web = await verifyNep413(pk, { message, nonce, recipient: RECIPIENT }, sig);
    const nodeOk = node413.verifyNep413(pk, { message, nonce, recipient: RECIPIENT }, sig);
    assert.equal(web, nodeOk, `case ${i}`);
  }
});
