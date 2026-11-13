// push (deploy with verify_jwt = true) - UI-160 Web Push subscriptions
//   GET|POST /push/key                                       -> { publicKey }   (VAPID public key, base64url; any valid Supabase JWT)
//   POST     /push/subscribe   { endpoint, keys: { p256dh, auth } } + Authorization: Bearer <user access token> -> 201 { subscribed: true }
//   POST     /push/unsubscribe { endpoint }                  + Authorization: Bearer <user access token> -> { unsubscribed: true, removed }
// The browser sends its own PushSubscription.toJSON(). Endpoint must be https on a known push service, body <= 4 KB,
// at most 10 devices per player. The VAPID key pair is generated on first use and kept in push_vapid_snacc
// (service role only); only the public key is ever returned. Delivery is done by push-dispatch.
import { fail, ok, preflight, type HandlerResult } from "../_shared/http.ts";
import { MAX_BODY_BYTES, handleSubscribe, handleUnsubscribe, type PushStore } from "../_shared/push.ts";
import { callerUserId, guarded, serviceClient } from "../_deno/db.ts";
import { loadVapid } from "../_deno/vapid.ts";

const sb = serviceClient();

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

const store: PushStore = {
  async countOthers(userId, exceptEndpoint) {
    const { count, error } = await sb
      .from("push_subscriptions_snacc")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .neq("endpoint", exceptEndpoint);
    check(error, "push_subscriptions_snacc count");
    return count ?? 0;
  },
  async upsert(row) {
    const { error } = await sb
      .from("push_subscriptions_snacc")
      .upsert({ ...row, failures: 0, last_ok_at: null, created_at: new Date().toISOString() }, { onConflict: "endpoint" });
    check(error, "push_subscriptions_snacc upsert");
  },
  async deleteOwn(userId, endpoint) {
    const { data, error } = await sb.from("push_subscriptions_snacc").delete().eq("user_id", userId).eq("endpoint", endpoint).select("id");
    check(error, "push_subscriptions_snacc delete");
    return data?.length ?? 0;
  },
};

/** Body as a JSON object, `"too_large"` when over the limit, or `null` when missing or malformed. */
async function readBody(req: Request): Promise<Record<string, unknown> | "too_large" | null> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return "too_large";
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function route(req: Request, path: string): Promise<HandlerResult> {
  if (path.endsWith("/key")) {
    if (req.method !== "GET" && req.method !== "POST") return fail(405, "method_not_allowed", "Use GET or POST.");
    return ok({ publicKey: (await loadVapid(sb)).publicKey });
  }
  const action = path.endsWith("/subscribe") ? "subscribe" : path.endsWith("/unsubscribe") ? "unsubscribe" : null;
  if (!action) return fail(404, "not_found", "Unknown push route.");
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");
  const userId = await callerUserId(sb, req);
  if (!userId) return fail(401, "unauthorized", "Missing or invalid session token.");
  const body = await readBody(req);
  if (body === "too_large") return fail(413, "too_large", "Body too large.");
  return action === "subscribe"
    ? handleSubscribe(userId, body, req.headers.get("user-agent"), store)
    : handleUnsubscribe(userId, body, store);
}

Deno.serve((req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  const origin = req.headers.get("origin");
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  return guarded("push", origin, () => route(req, path));
});
