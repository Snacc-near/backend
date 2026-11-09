// TEE-105..108 — the NEAR AI Cloud enclave client (M3): chat completions (temperature 0),
// fetching `/v1/signature/{chat_id}`, signed_text + ed25519 verification, caching,
// and the attestation report.
// Source of truth: snacc-vault/04 Arsitektur/Snacc - Spec API Backend dan TEE.md,
// Spike S2.6: signed_text === `${model}:${sha256(reqBody)}:${sha256(rawResBody)}`.
//
// AMBIGUITY (recorded, not resolved):
// A6. The /v1/signature response shape is not fully specified → accept the candidate keys
//     `signature`/`signature_hex`, `signing_address`/`signing_address_ed25519`, `text`/`signed_text`.
// A7. The cache = in-memory per process (not persistent) — enough for the demo & for de-duplicating
//     chat_ids; stated explicitly in the report.

import { createPublicKey, verify as edVerify } from "node:crypto";
import { sha256Hex } from "./redact.js";
import { TEE_MODEL, type PipelineOutput } from "./pipeline.js";

export const CHAT_COMPLETIONS_URL = "https://cloud-api.near.ai/v1/chat/completions";
export const SIGNATURE_URL_TEMPLATE = "https://cloud-api.near.ai/v1/signature/{chat_id}";
export const ATTESTATION_REPORT_URL = "https://cloud-api.near.ai/v1/attestation/report";

/** The `I-03` guardrail — identical to what the contract enforces. */
export const MAX_SHIFT_BPS = 1500;
export const MAX_VITALITY_BONUS = 500;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GenomeMutation {
  efficiency_shift_bps: number;
  vitality_bonus: number;
  phenotype_trait?: string;
  strain_id?: number | string;
}

export interface ExperimentResult {
  chatId: string;
  /** `<model>:<req_sha256>:<res_sha256>` — the shape signed by the enclave (S2.6). */
  signedText: string;
  signatureHex: string;
  /** The enclave's ed25519 pubkey (hex) from the `signing_address` field. */
  signingAddress: string;
  mutation: GenomeMutation;
  rawResponse: string;
  rawResponseSha256: string;
  /** true when the signed_text matches AND the ed25519 verification passes (or is explicitly skipped). */
  verified: boolean;
}

/** A per-process cache: `request_sha256_hex` → the experiment result (A7). */
const experimentCache = new Map<string, ExperimentResult>();

export function clearExperimentCache(): void {
  experimentCache.clear();
}

function firstString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  throw new Error(`ERR_TEE_RESPONSE_MISSING_FIELD: ${keys.join("/")}`);
}

/** Pure ed25519 verification (Node `crypto`) over `signedText` — split out so the real vector can be tested. */
export function verifyEd25519(pubkeyHex: string, message: string, signatureHex: string): boolean {
  try {
    const x = Buffer.from(pubkeyHex, "hex").toString("base64url");
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
    return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** Validate the mutation against the `I-03` guardrail (the same fence as the contract). */
export function validateMutation(m: GenomeMutation): void {
  if (typeof m.efficiency_shift_bps !== "number" || Math.abs(m.efficiency_shift_bps) > MAX_SHIFT_BPS) {
    throw new Error(`ERR_GUARDRAIL_SHIFT: ${m.efficiency_shift_bps}`);
  }
  if (typeof m.vitality_bonus !== "number" || m.vitality_bonus < 0 || m.vitality_bonus > MAX_VITALITY_BONUS) {
    throw new Error(`ERR_GUARDRAIL_VITALITY: ${m.vitality_bonus}`);
  }
}

export interface ExperimentOptions {
  apiKey?: string;
  fetchImpl?: FetchLike;
  /** Skip the cryptographic verification (only for tests with a mock response). Default: false. */
  skipSignatureVerification?: boolean;
}

/**
 * Full Stage 2: send `pipeline.request_body` to the enclave, fetch the signature, verify it,
 * parse the mutation. The result is cached per `request_sha256_hex`.
 */
export async function runGenomeExperiment(
  pipeline: PipelineOutput,
  opts: ExperimentOptions = {},
): Promise<ExperimentResult> {
  const cached = experimentCache.get(pipeline.request_sha256_hex);
  if (cached) return cached;

  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  // 1) Chat completions — the raw body MUST be intact for the hash computation (S2.6).
  const chatRes = await doFetch(CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers,
    body: pipeline.request_body,
  });
  if (!chatRes.ok) throw new Error(`ERR_TEE_CHAT_FAILED: HTTP ${chatRes.status}`);
  const rawResponse = await chatRes.text();
  const rawResponseSha256 = sha256Hex(rawResponse);
  const envelope = JSON.parse(rawResponse) as Record<string, unknown>;
  const chatId = firstString(envelope, ["id", "chat_id"]);

  // 2) The enclave signature over `<model>:<req_sha256>:<res_sha256>` (S2.6).
  const sigUrl = SIGNATURE_URL_TEMPLATE.replace("{chat_id}", chatId) + "?signing_algo=ed25519";
  const sigRes = await doFetch(sigUrl, { method: "GET", headers: { ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) } });
  if (!sigRes.ok) throw new Error(`ERR_TEE_SIGNATURE_FAILED: HTTP ${sigRes.status}`);
  const sigJson = JSON.parse(await sigRes.text()) as Record<string, unknown>;
  const signatureHex = firstString(sigJson, ["signature", "signature_hex"]);
  const signingAddress = firstString(sigJson, ["signing_address", "signing_address_ed25519"]);
  const signedText = `${TEE_MODEL}:${pipeline.request_sha256_hex}:${rawResponseSha256}`;

  // 3) Verification: the signed text matches + ed25519 passes (A6: the server-provided text
  //    is checked against the local reconstruction — when the server returns `text`, it must be identical).
  if (typeof sigJson.text === "string" && sigJson.text !== signedText) {
    throw new Error("ERR_TEE_SIGNED_TEXT_MISMATCH");
  }
  let verified = false;
  if (!opts.skipSignatureVerification) {
    verified = verifyEd25519(signingAddress, signedText, signatureHex);
    if (!verified) throw new Error("ERR_TEE_RESPONSE_HASH_OR_ED25519_MISMATCH");
  }

  // 4) Parse the mutation from `choices[0].message.content` + the I-03 guardrail.
  const choices = (envelope.choices ?? []) as Array<{ message?: { content?: string } }>;
  const content = choices[0]?.message?.content ?? "";
  const mutation = JSON.parse(content) as GenomeMutation;
  validateMutation(mutation);

  const result: ExperimentResult = {
    chatId,
    signedText,
    signatureHex,
    signingAddress,
    mutation,
    rawResponse,
    rawResponseSha256,
    verified,
  };
  experimentCache.set(pipeline.request_sha256_hex, result);
  return result;
}

/** The hardware enclave attestation report (`/v1/attestation/report`) — passed through as-is. */
export async function fetchAttestationReport(opts: { apiKey?: string; fetchImpl?: FetchLike } = {}): Promise<unknown> {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const res = await doFetch(ATTESTATION_REPORT_URL, {
    method: "GET",
    headers: { ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
  });
  if (!res.ok) throw new Error(`ERR_ATTESTATION_REPORT_FAILED: HTTP ${res.status}`);
  return JSON.parse(await res.text());
}
