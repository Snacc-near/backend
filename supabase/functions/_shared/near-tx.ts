/**
 * Minimal NEAR transaction signer for the `starter-pack` faucet: one `Transfer` action, Borsh-serialized
 * by hand and signed with Web Crypto Ed25519. Chosen over `npm:near-api-js` (large dependency tree,
 * slower cold start) because the faucet only ever needs this one transaction shape. The byte layout is
 * pinned by a test vector produced with near-api-js 7.4.0.
 *
 * Transaction (V0) = signer_id: String, public_key: { key_type: u8 = 0, data: [u8; 32] }, nonce: u64,
 *   receiver_id: String, block_hash: [u8; 32], actions: Vec<Action>; Action::Transfer = variant 3 { deposit: u128 }.
 * SignedTransaction = Transaction ‖ Signature { key_type: u8 = 0, data: [u8; 64] }; tx hash = sha256(Transaction).
 */

import {
  base58Decode,
  base58Encode,
  base64Decode,
  base64Encode,
  borshString,
  concatBytes,
  sha256,
  toArrayBuffer,
} from "./nep413.ts";
import { NearRpcError, summarizeTxStatus, type NearRpc } from "./near-rpc.ts";

/** 0.3 NEAR in yoctoNEAR. */
export const STARTER_AMOUNT_YOCTO = 300_000_000_000_000_000_000_000n;

const PKCS8_ED25519_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export interface SigningKey {
  /** `ed25519:<base58>` */
  publicKey: string;
  publicKeyRaw: Uint8Array;
  key: CryptoKey;
}

function leBytes(n: bigint, size: number): Uint8Array {
  if (n < 0n || n >= 1n << BigInt(size * 8)) throw new RangeError(`value does not fit in ${size} bytes`);
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** Parse a NEAR `ed25519:<base58>` secret key (64-byte seed‖pub, or a bare 32-byte seed). Errors never echo the key. */
export async function parseNearSecretKey(secret: string): Promise<SigningKey> {
  const raw = typeof secret === "string" && secret.startsWith("ed25519:") ? base58Decode(secret.slice("ed25519:".length)) : null;
  if (!raw || (raw.length !== 64 && raw.length !== 32)) throw new Error("faucet key: expected ed25519:<base58 of 64 or 32 bytes>");
  const pkcs8 = toArrayBuffer(concatBytes(PKCS8_ED25519_PREFIX, raw.subarray(0, 32)));
  const exportable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", exportable);
  const pub = typeof jwk.x === "string" ? base64Decode(jwk.x) : null;
  if (!pub || pub.length !== 32) throw new Error("faucet key: could not derive the public key");
  if (raw.length === 64 && raw.subarray(32).some((b, i) => b !== pub[i])) throw new Error("faucet key: embedded public key does not match");
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { publicKey: `ed25519:${base58Encode(pub)}`, publicKeyRaw: pub, key };
}

export interface TransferTx {
  signerId: string;
  publicKeyRaw: Uint8Array;
  nonce: bigint;
  receiverId: string;
  /** 32 bytes (base58-decoded recent block hash). */
  blockHash: Uint8Array;
  depositYocto: bigint;
}

export function serializeTransferTx(t: TransferTx): Uint8Array {
  if (t.publicKeyRaw.length !== 32 || t.blockHash.length !== 32) throw new RangeError("public key and block hash must be 32 bytes");
  return concatBytes(
    borshString(t.signerId),
    new Uint8Array([0]),
    t.publicKeyRaw,
    leBytes(t.nonce, 8),
    borshString(t.receiverId),
    t.blockHash,
    leBytes(1n, 4),
    new Uint8Array([3]),
    leBytes(t.depositYocto, 16),
  );
}

export async function signTransferTx(key: SigningKey, t: TransferTx): Promise<{ signedTxBase64: string; txHash: string }> {
  const msg = serializeTransferTx(t);
  const hash = await sha256(msg);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.key, toArrayBuffer(hash)));
  return { signedTxBase64: base64Encode(concatBytes(msg, new Uint8Array([0]), sig)), txHash: base58Encode(hash) };
}

/** The transfer was signed and submitted but no definitive answer came back. */
export class FaucetOutcomeUnknownError extends Error {
  constructor(readonly txHash: string) {
    super(`faucet transfer outcome unknown (tx ${txHash})`);
    this.name = "FaucetOutcomeUnknownError";
  }
}

/**
 * Faucet sender: reads the faucet key nonce + a recent block hash (`view_access_key`), signs a Transfer, submits
 * with `send_tx`, retries once on `InvalidNonce` (two claims racing). Returns the tx hash on success.
 */
export function makeFaucetSender(rpc: NearRpc, faucetAccountId: string, secretKey: string) {
  let keyPromise: Promise<SigningKey> | null = null;
  return async (receiverId: string, depositYocto: bigint): Promise<string> => {
    keyPromise ??= parseNearSecretKey(secretKey);
    const key = await keyPromise;
    for (let attempt = 0; ; attempt++) {
      const ak = await rpc.viewAccessKey(faucetAccountId, key.publicKey);
      if (!ak) throw new Error("faucet key is not an access key of the faucet account");
      const blockHash = base58Decode(ak.blockHash);
      if (!blockHash || blockHash.length !== 32) throw new Error("view_access_key returned no block hash");
      const signed = await signTransferTx(key, {
        signerId: faucetAccountId,
        publicKeyRaw: key.publicKeyRaw,
        nonce: ak.nonce + 1n,
        receiverId,
        blockHash,
        depositYocto,
      });
      try {
        const s = summarizeTxStatus(await rpc.sendTx(signed.signedTxBase64));
        if (!s || s.outcome !== "success") throw new Error(`transfer did not succeed (${s?.outcome ?? "unknown"})`);
        return signed.txHash;
      } catch (e) {
        const nonceRace = e instanceof NearRpcError && /InvalidNonce/.test(JSON.stringify(e.data ?? "") + e.message);
        if (nonceRace && attempt < 1) continue;
        if (e instanceof NearRpcError && e.kind === "transport") {
          // The signed tx may have reached the network: callers must not release the claim.
          throw new FaucetOutcomeUnknownError(signed.txHash);
        }
        throw e;
      }
    }
  };
}
