// TEE-102 — Layer 2: Optional Cloud Redaction Probe (ADR-05) + 404 fallback.
// TEE-103 — Pipeline output consistent with `commit_genome_experiment(strain_id, req_sha256_hex)`.
// Source of truth: Backend and TEE API Specification (`snacc-vault`) §1 Stages 1–2.
//
// Spec rules:
// - POST https://cloud-api.near.ai/v1/privacy/redact with { model, input }.
// - HTTP 200 -> cloud output is used; HTTP 404 (Spike S2.2 finding) -> record
//   `redaction_mode: "local_deterministic_sha256"` and proceed with Layer 1 output WITHOUT failing.
// - Pipeline must never fail because of Layer 2: network/5xx errors also fall back + add a warning.
//
// AMBIGUITIES (recorded, not invented):
// A3. The 200 response shape of /v1/privacy/redact is unspecified (endpoint returned 404 during spike) ->
//     accept candidate keys `redacted` / `text` / `output`; if absent, fall back to Layer 1.
// A4. The canonical request body hashed by `commit_genome_experiment` is not locked by spec ->
//     uses JSON.stringify of the Stage 2 request object (model, temperature, messages) as-is;
//     this convention is shared with the contract.

import {
  REDACTION_MODE_CLOUD,
  REDACTION_MODE_LOCAL,
  redactLayer1,
  sha256Hex,
} from "./redact.js";

export const CLOUD_REDACT_ENDPOINT = "https://cloud-api.near.ai/v1/privacy/redact";
export const CLOUD_CLASSIFY_ENDPOINT = "https://cloud-api.near.ai/v1/privacy/classify";
export const TEE_MODEL = "z-ai/glm-5.3-flash";

/** Deterministic rubric system prompt — copied VERBATIM from spec §1 Stage 2. */
export const TEE_SYSTEM_PROMPT =
  "You are the Snacc TEE Genome Oracle. Evaluate the bio-alchemical catalyst sequence and " +
  'output ONLY valid JSON with keys: {"efficiency_shift_bps": int between -1500 and 1500, ' +
  '"vitality_bonus": int between 0 and 500, "phenotype_trait": string}.';

export interface CloudRedactResult {
  /** Cloud redaction result, or null when falling back to Layer 1. */
  text: string | null;
  /** `"cloud"` when cloud output is used, otherwise `local_deterministic_sha256`. */
  mode: string;
  /** Non-fatal warning (e.g. endpoint 404). */
  warning?: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CloudClassifyResult {
  /** Classification label from `/v1/privacy/classify`; `null` when endpoint is unavailable. */
  label: string | null;
  warning?: string;
}

/**
 * `RES-102` — Layer 1.5: sensitivity classification BEFORE redaction (true Dual-Layer).
 * Never throws: 404/5xx/network errors → `label: null` + warning.
 */
export async function cloudClassify(
  payload: string,
  opts: { endpoint?: string; model?: string; apiKey?: string; fetchImpl?: FetchLike } = {},
): Promise<CloudClassifyResult> {
  const endpoint = opts.endpoint ?? CLOUD_CLASSIFY_ENDPOINT;
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: opts.model ?? TEE_MODEL, input: payload }),
    });
    if (res.status === 404) {
      return { label: null, warning: "layer1.5: /v1/privacy/classify 404 — classification skipped" };
    }
    if (!res.ok) {
      return { label: null, warning: `layer1.5: classify HTTP ${res.status} — classification skipped` };
    }
    const j = (await res.json()) as Record<string, unknown>;
    const label =
      [j.label, j.classification, j.sensitivity, j.risk].find(
        (v) => typeof v === "string" && v.length > 0,
      ) ?? null;
    return label ? { label: label as string } : { label: null, warning: "layer1.5: classify returned no recognized label" };
  } catch (e) {
    return { label: null, warning: `layer1.5: classify failed (${String(e).slice(0, 80)})` };
  }
}

/**
 * Layer 2 — cloud redaction probe. Never throws:
 * any failure (404, 5xx, network) falls back to Layer 1 + warning.
 */
export async function cloudRedact(
  payload: string,
  opts: {
    endpoint?: string;
    model?: string;
    apiKey?: string;
    fetchImpl?: FetchLike;
  } = {},
): Promise<CloudRedactResult> {
  const endpoint = opts.endpoint ?? CLOUD_REDACT_ENDPOINT;
  const model = opts.model ?? TEE_MODEL;
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify({ model, input: payload }),
    });
    if (res.status === 404) {
      return {
        text: null,
        mode: REDACTION_MODE_LOCAL,
        warning: "layer2: /v1/privacy/redact 404 (Spike S2.2 finding) — fallback to Layer 1",
      };
    }
    if (!res.ok) {
      return {
        text: null,
        mode: REDACTION_MODE_LOCAL,
        warning: `layer2: cloud redaction HTTP ${res.status} — fallback to Layer 1`,
      };
    }
    const body = (await res.json()) as Record<string, unknown>;
    const text = [body.redacted, body.text, body.output].find(
      (v): v is string => typeof v === "string",
    );
    if (text === undefined) {
      return {
        text: null,
        mode: REDACTION_MODE_LOCAL,
        warning: "layer2: 200 response without a recognized text field — fallback to Layer 1",
      };
    }
    return { text, mode: REDACTION_MODE_CLOUD };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      text: null,
      mode: REDACTION_MODE_LOCAL,
      warning: `layer2: cloud redaction failed (${reason}) — fallback to Layer 1`,
    };
  }
}

export interface PipelineInput {
  /** Target Strain ID (included in the user payload, not hashed separately). */
  strainId: number | string;
  /** Raw payload text that may contain identity markers & raw ingredient amounts. */
  payloadText: string;
  /** Payload substring containing raw recipe amounts (hidden behind the commitment). */
  rawFormula: string;
  /** Explicit salt (for determinism/tests); if omitted, a random salt is generated per request. */
  saltHex?: string;
  /** Layer 2 configuration (endpoint/apiKey/fetch stub). */
  cloud?: { endpoint?: string; apiKey?: string; fetchImpl?: FetchLike };
}

export interface PipelineOutput {
  /** `chat_id` from Stage 2 once available; Stage 1 pipeline does not generate it. */
  chat_id?: string;
  /** `sha256(request_body)` — value passed to `commit_genome_experiment(strain_id, req_sha256_hex)`. */
  request_sha256_hex: string;
  /** Final payload after redaction (`messages[1].content` body). */
  payload_terredaksi: string;
  /** `local_deterministic_sha256` or `cloud`. */
  redaction_mode: string;
  /** Collected non-fatal warnings from Layer 1 + Layer 2. */
  warnings: string[];
  /** Recipe stoichiometry commitment (hex). */
  commitment_hex: string;
  /** Salt used (hex). */
  salt_hex: string;
  /** Canonical request body that was hashed (for replay/audit — see ambiguity A4). */
  request_body: string;
  /** `RES-102` — `/v1/privacy/classify` classification label (null if endpoint unavailable). */
  classification?: string | null;
}

/**
 * Run Stage 1 (Layer 1 + Layer 2) and build the Stage 2 request.
 * `request_sha256_hex` = sha256(request_body) — consistent with
 * `commit_genome_experiment(strain_id, req_sha256_hex)` on the contract.
 */
export async function runGenomeRedactionPipeline(
  input: PipelineInput,
): Promise<PipelineOutput> {
  // Layer 1 — always runs (deterministic, zero I/O).
  const layer1 = redactLayer1(input.payloadText, input.rawFormula, input.saltHex);
  const warnings = [...layer1.warnings];
  let payload = layer1.payload_terredaksi;
  let mode = REDACTION_MODE_LOCAL;

  // Layer 1.5 (`RES-102`) — classify before redact (true Dual-Layer), 404 fallback.
  const classify = await cloudClassify(payload, input.cloud);
  if (classify.warning) warnings.push(classify.warning);

  // Layer 2 — optional, non-failing fallback.
  const cloud = await cloudRedact(payload, input.cloud);
  if (cloud.warning) warnings.push(cloud.warning);
  if (cloud.text !== null) {
    payload = cloud.text;
    mode = cloud.mode;
  }

  // Stage 2 request — exact structure from spec §1 Stage 2 (temperature 0, locked model).
  const requestBody = JSON.stringify({
    model: TEE_MODEL,
    temperature: 0,
    messages: [
      { role: "system", content: TEE_SYSTEM_PROMPT },
      {
        role: "user",
        content:
          `Strain #${input.strainId} | ` +
          `StoichiometryCommitment: ${layer1.commitment_hex} | ${payload}`,
      },
    ],
  });

  return {
    request_sha256_hex: sha256Hex(requestBody),
    payload_terredaksi: payload,
    redaction_mode: mode,
    warnings,
    commitment_hex: layer1.commitment_hex,
    salt_hex: layer1.salt_hex,
    request_body: requestBody,
    classification: classify.label,
  };
}
