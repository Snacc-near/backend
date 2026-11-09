/**
 * Proxy for the NEAR AI Cloud enclave hardware attestation report (`GET /v1/attestation/report`, VC-015).
 * Public (no API key required). Response is mapped directly to the spec shape:
 * `{ model, signingAddress, gatewayAttestation, modelAttestations }`.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const TEE_MODEL = "z-ai/glm-5.3-flash";
export const ATTESTATION_URL = `https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent(TEE_MODEL)}&signing_algo=ed25519`;
/** Report is ±300 KB and changes infrequently: cache briefly so public endpoint calls do not hammer upstream. */
export const ATTESTATION_TTL_MS = 60_000;
const UPSTREAM_TIMEOUT_MS = 15_000;

export interface AttestationResponse {
  model: string;
  signingAddress: string;
  gatewayAttestation: unknown;
  modelAttestations: unknown[];
  fetchedAt: string;
}

export type AttestationError = {
  error: "tee_upstream_unavailable" | "tee_upstream_malformed";
  detail: string;
};

let cache: { at: number; value: AttestationResponse } | null = null;

export function clearAttestationCache(): void {
  cache = null;
}

export async function fetchAttestation(
  fetchFn: FetchLike,
  now: () => number = Date.now,
): Promise<AttestationResponse | AttestationError> {
  if (cache && now() - cache.at < ATTESTATION_TTL_MS) return cache.value;
  let res: Response;
  try {
    res = await fetchFn(ATTESTATION_URL, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch (err) {
    return { error: "tee_upstream_unavailable", detail: String(err) };
  }
  if (!res.ok) return { error: "tee_upstream_unavailable", detail: `HTTP ${res.status}` };
  let raw: Record<string, unknown>;
  try {
    raw = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    return { error: "tee_upstream_malformed", detail: String(err) };
  }
  const gw = raw["gateway_attestation"] as Record<string, unknown> | undefined;
  const models = raw["model_attestations"];
  if (!gw || typeof gw["signing_address"] !== "string" || !Array.isArray(models)) {
    return { error: "tee_upstream_malformed", detail: "missing gateway_attestation/model_attestations" };
  }
  const value: AttestationResponse = {
    model: TEE_MODEL,
    signingAddress: gw["signing_address"],
    gatewayAttestation: gw,
    modelAttestations: models,
    fetchedAt: new Date(now()).toISOString(),
  };
  cache = { at: now(), value };
  return value;
}
