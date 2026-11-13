/**
 * NEP-413 signed-message verification with Web Crypto only (no `node:` imports, no Deno globals),
 * shared by the Supabase Edge Functions (Deno) and unit-tested from Node (`npm test`).
 * Same wire format as `src/nep413.ts`:
 *   signed bytes = sha256( u32le(2^31 + 413) ‖ borsh(Payload) )
 *   Payload = { message: String, nonce: [u8; 32], recipient: String, callback_url: Option<String> }
 * and an ed25519 signature over those 32 bytes.
 */

/** NEP-413 tag (2^31 + 413): domain prefix so a signed message can never be replayed as a transaction. */
export const NEP413_TAG = 2147484061;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_INDEX = new Map<string, number>([...B58].map((c, i) => [c, i]));

/** Copy into a fresh, exactly-sized ArrayBuffer (what Web Crypto wants as BufferSource). */
export function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.slice().buffer as ArrayBuffer;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesToHex(u: Uint8Array): string {
  let s = "";
  for (const b of u) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Base58 (Bitcoin alphabet) -> bytes; `null` if any character is outside the alphabet. */
export function base58Decode(s: string): Uint8Array | null {
  if (typeof s !== "string") return null;
  let n = 0n;
  for (const ch of s) {
    const i = B58_INDEX.get(ch);
    if (i === undefined) return null;
    n = n * 58n + BigInt(i);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.push(Number(n & 0xffn));
    n >>= 8n;
  }
  body.reverse();
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);
  return out;
}

/** Bytes -> Base58 (Bitcoin alphabet), leading zero bytes become leading "1"s. */
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58.charAt(Number(n % 58n)) + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** Bytes -> standard (padded) base64. */
export function base64Encode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Standard base64 or base64url (padding optional) -> bytes; `null` when malformed. */
export function base64Decode(s: string): Uint8Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(s)) return null;
  let t = s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (t.length % 4 === 1) return null;
  while (t.length % 4 !== 0) t += "=";
  try {
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** `ed25519:<base58>` -> 32-byte raw public key; `null` if the prefix or length is wrong. */
export function parseEd25519PublicKey(pk: string): Uint8Array | null {
  if (typeof pk !== "string" || !pk.startsWith("ed25519:")) return null;
  const raw = base58Decode(pk.slice("ed25519:".length));
  return raw && raw.length === 32 ? raw : null;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(data)));
}

export async function sha256Hex(s: string): Promise<string> {
  return bytesToHex(await sha256(utf8(s)));
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

export function borshString(s: string): Uint8Array {
  const b = utf8(s);
  return concatBytes(u32le(b.length), b);
}

export interface Nep413Payload {
  message: string;
  /** Exactly 32 bytes. */
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string | null;
}

/** Tag ‖ Borsh(Payload): the bytes whose sha256 the wallet signs. */
export function nep413Serialize(p: Nep413Payload): Uint8Array {
  const cb = p.callbackUrl ? concatBytes(new Uint8Array([1]), borshString(p.callbackUrl)) : new Uint8Array([0]);
  return concatBytes(u32le(NEP413_TAG), borshString(p.message), p.nonce, borshString(p.recipient), cb);
}

export async function nep413Hash(p: Nep413Payload): Promise<Uint8Array> {
  return sha256(nep413Serialize(p));
}

/** True iff `signature` (64 bytes) is a valid ed25519 signature by `publicKey` over the NEP-413 hash. */
export async function verifyNep413(publicKey: string, payload: Nep413Payload, signature: Uint8Array): Promise<boolean> {
  const raw = parseEd25519PublicKey(publicKey);
  if (!raw || payload.nonce.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", toArrayBuffer(raw), { name: "Ed25519" }, false, ["verify"]);
    const digest = await nep413Hash(payload);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, toArrayBuffer(signature), toArrayBuffer(digest));
  } catch {
    return false;
  }
}
