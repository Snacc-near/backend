/** CORS + JSON helpers shared by the Snacc Edge Functions (Web-standard Request/Response only). */

export const ALLOWED_ORIGINS: readonly string[] = [
  "https://snacc-nu.vercel.app",
  "http://localhost:4173",
  "http://localhost:5173",
];

/** Handler result before it becomes a Response. Errors use `{ error: "<code>", message: "<plain English>" }`. */
export interface HandlerResult {
  status: number;
  body: unknown;
}

export function ok(body: unknown, status = 200): HandlerResult {
  return { status, body };
}

export function fail(status: number, error: string, message: string, extra: Record<string, unknown> = {}): HandlerResult {
  return { status, body: { error, message, ...extra } };
}

export function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function toResponse(r: HandlerResult, origin: string | null, cors = true): Response {
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", ...(cors ? corsHeaders(origin) : {}) };
  return new Response(JSON.stringify(r.body), { status: r.status, headers });
}

/** 204 preflight answer, or `null` when the request is not a preflight. */
export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

/** Parse a JSON object body; `null` when missing, malformed, or not an object. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m?.[1] ? m[1].trim() : null;
}

/** Constant-time string comparison (cron secret). */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}
