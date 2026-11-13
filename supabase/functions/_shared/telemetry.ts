/**
 * OPS-127 `track` core: first-party usage funnel + client error reports, no third-party service.
 * Privacy by construction: no account ids, no IPs (only the starter-pack style HMAC for rate limiting),
 * routes are generalised (`/snacc/12` -> `/snacc/:id`, `/p/alice.testnet` -> `/p/:account`), event
 * props are a small allow-listed shape, and error text is scrubbed of anything that looks like a key,
 * token or URL query before it is stored.
 */

export const TELEMETRY_EVENTS = [
  "page_view",
  "onboarding_started",
  "onboarding_done",
  "wallet_connect_click",
  "wallet_connected",
  "signed_in",
  "tx_submitted",
  "tx_succeeded",
  "tx_failed",
  "quest_opened",
  "share_clicked",
  "starter_claimed",
] as const;
export type TelemetryEvent = (typeof TELEMETRY_EVENTS)[number];

export const MAX_BODY_BYTES = 16_384;
export const MAX_ITEMS = 20;
/** Rows per hashed client IP per rolling hour. */
export const RATE_PER_HOUR = 300;

export interface TelemetryRow {
  kind: "event" | "error";
  name: string;
  device_id: string;
  session_id: string;
  route: string;
  props: Record<string, string | number | boolean>;
  message: string | null;
  stack: string | null;
  client_at: string;
}

const ID_RE = /^[a-z0-9-]{8,64}$/;
const KEY_RE = /^[a-z_]{1,24}$/;

/** `/snacc/12` -> `/snacc/:id`, `/p/<account>` -> `/p/:account`, query/hash dropped, unknown shapes -> `/other`. */
export function generaliseRoute(raw: unknown): string {
  if (typeof raw !== "string") return "/other";
  const path = raw.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  if (/^\/snacc\/\d{1,9}$/.test(path)) return "/snacc/:id";
  if (/^\/p\/[^/]{2,64}$/.test(path)) return "/p/:account";
  if (["/", "/app", "/sign", "/terms", "/privacy"].includes(path)) return path;
  if (path.startsWith("/app/")) return "/app";
  return "/other";
}

/** Removes keys, JWTs, long base58/hex runs, emails, URL queries and NEAR account ids from free text. */
export function scrub(text: string, max: number): string {
  return text
    .replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{20,}/g, "[key]")
    .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/g, "[jwt]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/([?&][\w-]+=)[^&\s#"']*/g, "$1[x]")
    .replace(/\b[a-z0-9_-]{2,64}\.(testnet|near)\b/g, "[account]")
    .replace(/\b[0-9a-f]{64}\b/g, "[hex]")
    .replace(/\b[1-9A-HJ-NP-Za-km-z]{40,}\b/g, "[b58]")
    .slice(0, max);
}

function cleanProps(raw: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= 8) break;
    if (!KEY_RE.test(k)) continue;
    if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = Math.round(v * 1000) / 1000;
    else if (typeof v === "string") out[k] = scrub(v, 64);
  }
  return out;
}

function clientAt(raw: unknown, nowMs: number): string {
  const t = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) : NaN;
  const ok = Number.isFinite(t) && Math.abs(t - nowMs) <= 86_400_000;
  return new Date(ok ? t : nowMs).toISOString();
}

/** Validates one POST body. Invalid items are counted and dropped, never stored. */
export function parseBatch(body: unknown, nowMs: number): { rows: TelemetryRow[]; rejected: number } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const device = typeof b.deviceId === "string" ? b.deviceId.toLowerCase() : "";
  const session = typeof b.sessionId === "string" ? b.sessionId.toLowerCase() : "";
  if (!ID_RE.test(device) || !ID_RE.test(session)) return null;
  const events = Array.isArray(b.events) ? b.events : [];
  const errors = Array.isArray(b.errors) ? b.errors : [];
  const rows: TelemetryRow[] = [];
  let rejected = 0;
  for (const e of events) {
    if (rows.length >= MAX_ITEMS) { rejected++; continue; }
    const ev = (e ?? {}) as Record<string, unknown>;
    if (typeof ev.name !== "string" || !(TELEMETRY_EVENTS as readonly string[]).includes(ev.name)) { rejected++; continue; }
    rows.push({
      kind: "event", name: ev.name, device_id: device, session_id: session, route: generaliseRoute(ev.route),
      props: cleanProps(ev.props), message: null, stack: null, client_at: clientAt(ev.ts, nowMs),
    });
  }
  for (const e of errors) {
    if (rows.length >= MAX_ITEMS) { rejected++; continue; }
    const er = (e ?? {}) as Record<string, unknown>;
    if (typeof er.message !== "string" || er.message.trim() === "") { rejected++; continue; }
    const name = typeof er.name === "string" && /^[A-Za-z]{1,40}$/.test(er.name) ? er.name : "Error";
    rows.push({
      kind: "error", name, device_id: device, session_id: session, route: generaliseRoute(er.route),
      props: cleanProps(er.props), message: scrub(er.message, 300),
      stack: typeof er.stack === "string" ? scrub(er.stack, 1500) : null, client_at: clientAt(er.ts, nowMs),
    });
  }
  return { rows, rejected };
}
