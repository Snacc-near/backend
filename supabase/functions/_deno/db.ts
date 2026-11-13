// Deno-only glue shared by the Snacc Edge Functions: env, service-role client, caller lookup.
// Kept out of `_shared/` because it imports supabase-js via `npm:` and uses `Deno.env`.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { bearerToken, fail, safeEqual, toResponse, type HandlerResult } from "../_shared/http.ts";

export function env(name: string): string | undefined {
  const v = Deno.env.get(name);
  return v && v.trim() !== "" ? v.trim() : undefined;
}

/** Service-role client (bypasses RLS). Never expose its key; `SUPABASE_*` are injected by the platform. */
export function serviceClient(): SupabaseClient {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

/** Auth user id of the caller's JWT (`Authorization: Bearer <access token>`), or `null`. */
export async function callerUserId(sb: SupabaseClient, req: Request): Promise<string | null> {
  const token = bearerToken(req);
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user.id;
}

export async function nearAccountIdOf(sb: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await sb.from("profiles_snacc").select("near_account_id").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`profiles_snacc: ${error.message}`);
  return (data as { near_account_id?: string } | null)?.near_account_id ?? null;
}

/**
 * Cron-secret check shared by the cron-driven functions (OPS-128): the `x-cron-secret` header is compared with
 * Supabase Vault through `snacc_cron_secret_ok()`. An explicit `SNACC_CRON_SECRET` edge secret still wins when set.
 */
export async function cronSecretCheck(sb: SupabaseClient, name: string, got: string): Promise<"ok" | "bad" | "unavailable"> {
  if (!got) return "bad";
  const secret = env("SNACC_CRON_SECRET");
  if (secret) return safeEqual(got, secret) ? "ok" : "bad";
  const { data, error } = await sb.rpc("snacc_cron_secret_ok", { candidate: got });
  if (error) {
    console.error(`${name}: snacc_cron_secret_ok failed`, error.message);
    return "unavailable";
  }
  return data === true ? "ok" : "bad";
}

/** Wrap a handler so unexpected errors become a JSON 500 (no stack traces or secrets in the body). */
export async function guarded(name: string, origin: string | null, run: () => Promise<HandlerResult>, cors = true): Promise<Response> {
  try {
    return toResponse(await run(), origin, cors);
  } catch (e) {
    console.error(`${name}: unexpected error`, e instanceof Error ? e.message.slice(0, 300) : "unknown");
    return toResponse(fail(500, "internal_error", "Unexpected server error."), origin, cors);
  }
}
