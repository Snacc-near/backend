// TEE-102 — Layer 2: Optional Cloud Redaction Probe (ADR-05) + fallback 404.
// TEE-103 — Pipeline output konsisten dengan `commit_genome_experiment(strain_id, req_sha256_hex)`.
// Sumber kebenaran: snacc-vault/04 Arsitektur/Snacc - Spec API Backend dan TEE.md §1 Tahap 1–2.
//
// Aturan spec:
// - POST https://cloud-api.near.ai/v1/privacy/redact dengan { model, input }.
// - HTTP 200 -> hasil cloud dipakai; HTTP 404 (temuan Spike S2.2) -> catat
//   `redaction_mode: "local_deterministic_sha256"` dan lanjut dengan hasil Layer 1 TANPA gagal.
// - Pipeline tidak boleh gagal karena Layer 2: error jaringan/5xx juga fallback + warning.
//
// AMBIGUITAS (dicatat, tidak diarang):
// A3. Bentuk respons 200 /v1/privacy/redact tidak dispesifikkan (endpoint 404 saat spike) ->
//     terima key kandidat `redacted` / `text` / `output`; jika tak ada, fallback ke Layer 1.
// A4. Bentuk canonical request body yang di-hash `commit_genome_experiment` belum dikunci spec ->
//     dipakai JSON.stringify dari objek request Tahap 2 (model, temperature, messages) apa adanya;
//     kesepakatan ini harus dikunci bersama kontrak sebelum mainnet.

import {
  REDACTION_MODE_CLOUD,
  REDACTION_MODE_LOCAL,
  redactLayer1,
  sha256Hex,
} from "./redact.js";

export const CLOUD_REDACT_ENDPOINT = "https://cloud-api.near.ai/v1/privacy/redact";
export const CLOUD_CLASSIFY_ENDPOINT = "https://cloud-api.near.ai/v1/privacy/classify";
export const TEE_MODEL = "z-ai/glm-5.3-flash";

/** System prompt rubrik deterministik — disalin PERSIS dari spec §1 Tahap 2. */
export const TEE_SYSTEM_PROMPT =
  "You are the Snacc TEE Genome Oracle. Evaluate the bio-alchemical catalyst sequence and " +
  'output ONLY valid JSON with keys: {"efficiency_shift_bps": int between -1500 and 1500, ' +
  '"vitality_bonus": int between 0 and 500, "phenotype_trait": string}.';

export interface CloudRedactResult {
  /** Hasil redaksi cloud, atau null bila fallback ke Layer 1. */
  text: string | null;
  /** `"cloud"` bila hasil cloud dipakai, selain itu `local_deterministic_sha256`. */
  mode: string;
  /** Peringatan non-fatal (mis. endpoint 404). */
  warning?: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CloudClassifyResult {
  /** Label klasifikasi dari `/v1/privacy/classify`; `null` bila endpoint tak tersedia. */
  label: string | null;
  warning?: string;
}

/**
 * `RES-102` — Layer 1.5: klasifikasi sensitivitas SEBELUM redact (Dual-Layer sejati).
 * Tidak pernah melempar exception: 404/5xx/jaringan → `label: null` + warning.
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
      return { label: null, warning: "layer1.5: /v1/privacy/classify 404 — klasifikasi dilewati" };
    }
    if (!res.ok) {
      return { label: null, warning: `layer1.5: classify HTTP ${res.status} — klasifikasi dilewati` };
    }
    const j = (await res.json()) as Record<string, unknown>;
    const label =
      [j.label, j.classification, j.sensitivity, j.risk].find(
        (v) => typeof v === "string" && v.length > 0,
      ) ?? null;
    return label ? { label: label as string } : { label: null, warning: "layer1.5: classify tanpa label dikenal" };
  } catch (e) {
    return { label: null, warning: `layer1.5: classify gagal (${String(e).slice(0, 80)})` };
  }
}

/**
 * Layer 2 — probe redaksi cloud. Tidak pernah melempar exception:
 * kegagalan apa pun (404, 5xx, jaringan) jatuh ke fallback Layer 1 + warning.
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
        warning: "layer2: /v1/privacy/redact 404 (temuan Spike S2.2) — fallback ke Layer 1",
      };
    }
    if (!res.ok) {
      return {
        text: null,
        mode: REDACTION_MODE_LOCAL,
        warning: `layer2: cloud redaction HTTP ${res.status} — fallback ke Layer 1`,
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
        warning: "layer2: respons 200 tanpa field teks yang dikenali — fallback ke Layer 1",
      };
    }
    return { text, mode: REDACTION_MODE_CLOUD };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      text: null,
      mode: REDACTION_MODE_LOCAL,
      warning: `layer2: cloud redaction gagal (${reason}) — fallback ke Layer 1`,
    };
  }
}

export interface PipelineInput {
  /** ID Strain tujuan (diteruskan ke payload user, tidak masuk hash request). */
  strainId: number | string;
  /** Payload mentah yang mungkin memuat identitas & takaran mentah. */
  payloadText: string;
  /** Substring payload berisi takaran mentah resep (disembunyikan di balik komitmen). */
  rawFormula: string;
  /** Salt eksplisit (untuk determinisme/test); bila absen, salt acak per request. */
  saltHex?: string;
  /** Konfigurasi Layer 2 (endpoint/apiKey/fetch stub). */
  cloud?: { endpoint?: string; apiKey?: string; fetchImpl?: FetchLike };
}

export interface PipelineOutput {
  /** `chat_id` dari Tahap 2 bila sudah ada; pipeline Tahap 1 tidak membuatnya. */
  chat_id?: string;
  /** `sha256(request_body)` — nilai yang dikirim ke `commit_genome_experiment(strain_id, req_sha256_hex)`. */
  request_sha256_hex: string;
  /** Payload final setelah redaksi (isi `messages[1].content`). */
  payload_terredaksi: string;
  /** `local_deterministic_sha256` atau `cloud`. */
  redaction_mode: string;
  /** Kumpulan warning non-fatal Layer 1 + Layer 2. */
  warnings: string[];
  /** Komitmen takaran resep (hex). */
  commitment_hex: string;
  /** Salt yang dipakai (hex). */
  salt_hex: string;
  /** Canonical request body yang di-hash (untuk replay/audit — lihat ambiguitas A4). */
  request_body: string;
  /** `RES-102` — label klasifikasi `/v1/privacy/classify` (null bila endpoint tak tersedia). */
  classification?: string | null;
}

/**
 * Jalankan Tahap 1 (Layer 1 + Layer 2) dan bangun request Tahap 2.
 * `request_sha256_hex` = sha256(request_body) — konsisten dengan
 * `commit_genome_experiment(strain_id, req_sha256_hex)` pada kontrak.
 */
export async function runGenomeRedactionPipeline(
  input: PipelineInput,
): Promise<PipelineOutput> {
  // Layer 1 — selalu jalan (deterministik, tanpa I/O).
  const layer1 = redactLayer1(input.payloadText, input.rawFormula, input.saltHex);
  const warnings = [...layer1.warnings];
  let payload = layer1.payload_terredaksi;
  let mode = REDACTION_MODE_LOCAL;

  // Layer 1.5 (`RES-102`) — klasifikasi sebelum redact (Dual-Layer sejati), fallback 404.
  const classify = await cloudClassify(payload, input.cloud);
  if (classify.warning) warnings.push(classify.warning);

  // Layer 2 — opsional, fallback tanpa gagal.
  const cloud = await cloudRedact(payload, input.cloud);
  if (cloud.warning) warnings.push(cloud.warning);
  if (cloud.text !== null) {
    payload = cloud.text;
    mode = cloud.mode;
  }

  // Request Tahap 2 — struktur persis spec §1 Tahap 2 (temperature 0, model terkunci).
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
