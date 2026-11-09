/**
 * NEP-413 signed message verification (VC-015), pure Node.
 * Signed payload = sha256( u32le(2^31 + 413) ‖ borsh(Payload) ), where Payload =
 * { message: String, nonce: [u8;32], recipient: String, callback_url: Option<String> }.
 * ed25519 signature over that hash.
 */

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

/** NEP-413 tag (2^31 + 413), domain prefix ensuring a signed message cannot be replayed as a transaction. */
export const NEP413_TAG = 2147484061;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet) -> bytes; returns `null` if any invalid character is present. */
export function base58Decode(s: string): Buffer | null {
  if (s.length === 0) return Buffer.alloc(0);
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const hex = n === 0n ? "" : n.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return Buffer.concat([Buffer.alloc(zeros), body]);
}

/** `ed25519:<base58>` -> 32-byte raw public key; returns `null` if format/length is invalid. */
export function parseEd25519PublicKey(pk: string): Buffer | null {
  if (!pk.startsWith("ed25519:")) return null;
  const raw = base58Decode(pk.slice("ed25519:".length));
  return raw && raw.length === 32 ? raw : null;
}

function borshString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
}

export interface Nep413Payload {
  message: string;
  nonce: Buffer; // 32 bytes
  recipient: string;
  callbackUrl?: string | null;
}

/** sha256 over the NEP-413 Borsh serialization — the exact bytes signed by the wallet. */
export function nep413Hash(p: Nep413Payload): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const cb = p.callbackUrl ? Buffer.concat([Buffer.from([1]), borshString(p.callbackUrl)]) : Buffer.from([0]);
  const ser = Buffer.concat([tag, borshString(p.message), p.nonce, borshString(p.recipient), cb]);
  return createHash("sha256").update(ser).digest();
}

/** SPKI DER prefix for a raw 32-byte ed25519 public key. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function verifyNep413(publicKey: string, payload: Nep413Payload, signature: Buffer): boolean {
  const raw = parseEd25519PublicKey(publicKey);
  if (!raw || payload.nonce.length !== 32 || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
    return edVerify(null, nep413Hash(payload), key, signature);
  } catch {
    return false;
  }
}

/** Standard base64 or base64url -> bytes (different wallets emit different variants). */
export function decodeB64(s: string): Buffer | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
