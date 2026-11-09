/**
 * `POST /api/tee/evaluate-genome` (VC-015): Spec Stages 1-3 (Dual-Layer Redaction -> NEAR AI Cloud TEE
 * `z-ai/glm-5.3-flash` -> `/v1/signature/{chat_id}`), gated because it uses the server's NEAR AI key:
 *
 *  1. `NEAR_AI_API_KEY` comes strictly from the server env (injected in `main.ts`); never logged or returned.
 *  2. Strain owner only: signed NEP-413 message whose public key is a FullAccess key on the account
 *     (`view_access_key`), and that account equals the strain's `owner_id` (`get_strain`).
 *  3. Message expires after 5 minutes; single-use nonce.
 *  4. Rate limit of 3/hour per strain and 50/day total (in-memory, resets on restart).
 *
 * Redaction/enclave call logic is reused from `./oracle/*` (vendored copy of `oracle-tee`, see SYNC.md).
 */

import { NearRpcClient } from "./near.js";
import { fetchStrain } from "./macro.js";
import { isValidAccountId } from "./views.js";
import { decodeB64, verifyNep413 } from "./nep413.js";
import { runGenomeRedactionPipeline } from "./oracle/pipeline.js";
import { runGenomeExperiment } from "./oracle/enclave-client.js";
import type { FetchLike } from "./tee.js";

/** NEP-413 recipient required from the signer (domain separator; not a secret). */
export const EVALUATE_RECIPIENT = "snacc-backend";
/** Required `action` value inside the JSON `message`. */
export const EVALUATE_ACTION = "evaluate-genome";
export const SIGNATURE_MAX_AGE_MS = 5 * 60_000;
/** Tolerance for client clocks running slightly ahead of the server. */
export const SIGNATURE_FUTURE_SKEW_MS = 60_000;
export const RATE_PER_STRAIN_PER_HOUR = 3;
export const RATE_TOTAL_PER_DAY = 50;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_PAYLOAD_CHARS = 4000;
export const MAX_FORMULA_CHARS = 1000;
const UPSTREAM_TIMEOUT_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface EvaluateResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Used nonces; entries are evicted once past the message validity window (cannot be replayed anyway). */
export class NonceStore {
  private readonly used = new Map<string, number>();
  has(nonceHex: string): boolean {
    return this.used.has(nonceHex);
  }
  consume(nonceHex: string, now: number): void {
    for (const [k, at] of this.used) {
      if (now - at > SIGNATURE_MAX_AGE_MS + SIGNATURE_FUTURE_SKEW_MS) this.used.delete(k);
    }
    this.used.set(nonceHex, now);
  }
}

export type RateDecision = { ok: true } | { ok: false; scope: "strain" | "global"; retryAfterSec: number };

/** Sliding window: 3/hour per strain, 50/day total. `take` records the hit only if both limits pass. */
export class RateLimiter {
  private readonly perStrain = new Map<number, number[]>();
  private total: number[] = [];

  take(strainId: number, now: number): RateDecision {
    this.total = this.total.filter((t) => now - t < DAY_MS);
    const mine = (this.perStrain.get(strainId) ?? []).filter((t) => now - t < HOUR_MS);
    if (mine.length >= RATE_PER_STRAIN_PER_HOUR) {
      const oldest = mine[0] as number;
      return { ok: false, scope: "strain", retryAfterSec: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000)) };
    }
    if (this.total.length >= RATE_TOTAL_PER_DAY) {
      const oldest = this.total[0] as number;
      return { ok: false, scope: "global", retryAfterSec: Math.max(1, Math.ceil((oldest + DAY_MS - now) / 1000)) };
    }
    mine.push(now);
    this.perStrain.set(strainId, mine);
    this.total.push(now);
    return { ok: true };
  }
}

export interface EvaluateDeps {
  /** `NEAR_AI_API_KEY` from server env; empty -> 503 `tee_not_configured`. */
  apiKey?: string;
  fetchFn?: FetchLike;
  now?: () => number;
  nonces: NonceStore;
  limiter: RateLimiter;
}

export function newEvaluateState(): Pick<EvaluateDeps, "nonces" | "limiter"> {
  return { nonces: new NonceStore(), limiter: new RateLimiter() };
}

const fail = (status: number, error: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>): EvaluateResult => ({
  status,
  body: { error, ...extra },
  ...(headers ? { headers } : {}),
});

interface ParsedAuth {
  account_id: string;
  public_key: string;
  signature: string;
  nonce: string;
  message: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseBody(
  body: unknown,
): { strainId: number; payloadText: string; rawFormula: string; auth: ParsedAuth } | EvaluateResult {
  if (!isRecord(body)) return fail(400, "invalid_request", { field: "body" });
  const strainId = body["strain_id"];
  if (typeof strainId !== "number" || !Number.isSafeInteger(strainId) || strainId < 0) {
    return fail(400, "invalid_request", { field: "strain_id" });
  }
  const payloadText = body["payload_text"];
  if (typeof payloadText !== "string" || payloadText.length === 0 || payloadText.length > MAX_PAYLOAD_CHARS) {
    return fail(400, "invalid_request", { field: "payload_text" });
  }
  const rawFormula = body["raw_formula"];
  if (typeof rawFormula !== "string" || rawFormula.length > MAX_FORMULA_CHARS) {
    return fail(400, "invalid_request", { field: "raw_formula" });
  }
  const auth = body["auth"];
  if (!isRecord(auth)) return fail(401, "auth_required", { field: "auth" });
  for (const f of ["account_id", "public_key", "signature", "nonce", "message"] as const) {
    if (typeof auth[f] !== "string" || (auth[f] as string).length === 0 || (auth[f] as string).length > 2048) {
      return fail(401, "auth_required", { field: `auth.${f}` });
    }
  }
  return { strainId, payloadText, rawFormula, auth: auth as unknown as ParsedAuth };
}

/** Authenticate + authorize strain owner. Returns `null` on success, or a rejection response. */
async function authorizeOwner(
  strainId: number,
  auth: ParsedAuth,
  rpc: NearRpcClient,
  contractId: string,
  deps: EvaluateDeps,
  now: number,
): Promise<EvaluateResult | null> {
  if (!isValidAccountId(auth.account_id)) return fail(400, "invalid_account_id");

  // message = JSON {action, strain_id, timestamp(ms)} binding the signature to this strain.
  let msg: unknown;
  try {
    msg = JSON.parse(auth.message);
  } catch {
    return fail(401, "invalid_message");
  }
  if (
    !isRecord(msg) ||
    msg["action"] !== EVALUATE_ACTION ||
    msg["strain_id"] !== strainId ||
    typeof msg["timestamp"] !== "number" ||
    !Number.isFinite(msg["timestamp"])
  ) {
    return fail(401, "invalid_message");
  }
  const ts = msg["timestamp"];
  if (now - ts > SIGNATURE_MAX_AGE_MS || ts - now > SIGNATURE_FUTURE_SKEW_MS) {
    return fail(401, "signature_expired");
  }

  const nonce = decodeB64(auth.nonce);
  if (!nonce || nonce.length !== 32) return fail(401, "invalid_nonce");
  const nonceHex = nonce.toString("hex");
  if (deps.nonces.has(nonceHex)) return fail(401, "nonce_reused");

  const sig = decodeB64(auth.signature);
  if (!sig || !verifyNep413(auth.public_key, { message: auth.message, nonce, recipient: EVALUATE_RECIPIENT }, sig)) {
    return fail(401, "invalid_signature");
  }
  // Valid signature: consume the nonce NOW (synchronously, before await) so parallel requests cannot double-pass.
  deps.nonces.consume(nonceHex, now);

  // Public key must belong to the account and be FullAccess (FunctionCall keys may be held by third-party dApps).
  const key = await rpc.viewAccessKey(auth.account_id, auth.public_key);
  if (!key) return fail(403, "public_key_not_owned");
  if (key.permission !== "FullAccess") return fail(403, "public_key_not_full_access");

  const strain = await fetchStrain(rpc, contractId, strainId);
  if ("error" in strain) {
    return strain.error === "strain_not_found" ? fail(404, "strain_not_found") : fail(503, strain.error);
  }
  if (strain.owner_id !== auth.account_id) return fail(403, "not_strain_owner");
  return null;
}

export async function evaluateGenome(
  rawBody: unknown,
  rpc: NearRpcClient,
  contractId: string,
  deps: EvaluateDeps,
): Promise<EvaluateResult> {
  const apiKey = deps.apiKey;
  if (!apiKey) return fail(503, "tee_not_configured");

  const parsed = parseBody(rawBody);
  if ("status" in parsed) return parsed;
  const { strainId, payloadText, rawFormula, auth } = parsed;
  const now = (deps.now ?? Date.now)();

  const denied = await authorizeOwner(strainId, auth, rpc, contractId, deps, now);
  if (denied) return denied;

  const rate = deps.limiter.take(strainId, now);
  if (!rate.ok) {
    return fail(429, "rate_limited", { scope: rate.scope, retryAfterSec: rate.retryAfterSec }, {
      "Retry-After": String(rate.retryAfterSec),
    });
  }

  const scrub = (s: string): string => s.split(apiKey).join("[redacted]");
  const baseFetch = deps.fetchFn ?? fetch;
  const fetchImpl = (url: string, init: RequestInit): Promise<Response> =>
    baseFetch(url, { ...init, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });

  try {
    const pipeline = await runGenomeRedactionPipeline({
      strainId,
      payloadText,
      rawFormula,
      cloud: { apiKey, fetchImpl },
    });
    const exp = await runGenomeExperiment(pipeline, { apiKey, fetchImpl });
    return {
      status: 200,
      body: {
        chatId: exp.chatId,
        signedText: exp.signedText,
        signatureHex: exp.signatureHex,
        signingAddress: exp.signingAddress,
        // Exact raw enclave response bytes as received — must remain intact for
        // `apply_tee_mutation_zero_trust` (the contract recomputes its sha256).
        raw_response_body: exp.rawResponse,
        mutation: exp.mutation,
        redactionReport: {
          redaction_mode: pipeline.redaction_mode,
          classification: pipeline.classification ?? null,
          warnings: pipeline.warnings,
          commitment_hex: pipeline.commitment_hex,
          salt_hex: pipeline.salt_hex,
          request_sha256_hex: pipeline.request_sha256_hex,
          payload_terredaksi: pipeline.payload_terredaksi,
          signature_verified: exp.verified,
        },
      },
    };
  } catch (err) {
    const detail = scrub(err instanceof Error ? err.message : String(err)).slice(0, 200);
    if (detail.startsWith("ERR_GUARDRAIL_")) return fail(502, "tee_guardrail_rejected", { detail });
    return fail(502, "tee_upstream_failed", { detail });
  }
}
