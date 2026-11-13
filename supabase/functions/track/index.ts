// track (deploy with verify_jwt = false) — OPS-127 first-party usage funnel + client error reports.
//   POST /track  {"deviceId","sessionId","events":[{name,route,props,ts}],"errors":[{name,message,stack,route,ts}]}
//   -> 202 {"stored": n, "rejected": m}
// Only allowed origins (the Snacc web app), max 16 KB / 20 items per request, max 300 rows per hashed client
// IP per hour (429 rate_limited). No account ids or raw IPs are stored; see _shared/telemetry.ts.
import { ALLOWED_ORIGINS, fail, ok, preflight, toResponse } from "../_shared/http.ts";
import { clientIp, hashClientIp } from "../_shared/starter.ts";
import { MAX_BODY_BYTES, RATE_PER_HOUR, parseBatch } from "../_shared/telemetry.ts";
import { env, guarded, serviceClient } from "../_deno/db.ts";

const sb = serviceClient();
const ipHashKey = env("SNACC_IP_HASH_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY") ?? "";

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  const origin = req.headers.get("origin");
  if (req.method !== "POST") return toResponse(fail(405, "method_not_allowed", "Use POST."), origin);
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return toResponse(fail(403, "origin_not_allowed", "Unknown origin."), origin);
  return guarded("track", origin, async () => {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return fail(413, "too_large", "Body too large.");
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return fail(400, "bad_json", "Body must be JSON.");
    }
    const parsed = parseBatch(body, Date.now());
    if (!parsed) return fail(400, "bad_request", "deviceId and sessionId are required.");
    if (parsed.rows.length === 0) return ok({ stored: 0, rejected: parsed.rejected }, 202);

    const ipHash = await hashClientIp(clientIp(req.headers), ipHashKey);
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count, error: ce } = await sb
      .from("client_telemetry_snacc")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", since);
    if (ce) throw new Error(`client_telemetry_snacc count: ${ce.message}`);
    if ((count ?? 0) + parsed.rows.length > RATE_PER_HOUR) return fail(429, "rate_limited", "Too many reports from this network.");

    const { error } = await sb.from("client_telemetry_snacc").insert(parsed.rows.map((r) => ({ ...r, ip_hash: ipHash })));
    if (error) throw new Error(`client_telemetry_snacc insert: ${error.message}`);
    return ok({ stored: parsed.rows.length, rejected: parsed.rejected }, 202);
  });
});
