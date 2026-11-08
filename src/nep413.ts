/**
 * Verifikasi pesan bertanda tangan NEP-413 (VC-015), Node murni.
 * Payload yang ditandatangani = sha256( u32le(2^31 + 413) ‖ borsh(Payload) ), Payload =
 * { message: String, nonce: [u8;32], recipient: String, callback_url: Option<String> }.
 * Tanda tangan ed25519 atas hash tersebut.
 */

import { createHash, createPublicKey, verify as edVerify } from "node:crypto";

/** Tag NEP-413 (2^31 + 413), prefix domain agar tanda tangan tak bisa dipakai sebagai tx. */
export const NEP413_TAG = 2147484061;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (alfabet Bitcoin) -> bytes; `null` bila ada karakter tak valid. */
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

/** `ed25519:<base58>` -> 32 byte kunci publik; `null` bila format/panjang salah. */
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
  nonce: Buffer; // 32 byte
  recipient: string;
  callbackUrl?: string | null;
}

/** sha256 atas serialisasi borsh NEP-413 — byte yang benar-benar ditandatangani dompet. */
export function nep413Hash(p: Nep413Payload): Buffer {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(NEP413_TAG);
  const cb = p.callbackUrl ? Buffer.concat([Buffer.from([1]), borshString(p.callbackUrl)]) : Buffer.from([0]);
  const ser = Buffer.concat([tag, borshString(p.message), p.nonce, borshString(p.recipient), cb]);
  return createHash("sha256").update(ser).digest();
}

/** SPKI DER prefix untuk kunci publik ed25519 mentah 32 byte. */
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

/** Base64 standar atau base64url -> bytes (dompet berbeda memakai varian berbeda). */
export function decodeB64(s: string): Buffer | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return null;
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
