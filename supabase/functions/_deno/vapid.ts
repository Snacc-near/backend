// Deno-only glue for the VAPID key (UI-160): the service-only table `push_vapid_snacc` behind `VapidStore`.
// The private key is generated inside the Edge Function on first use (Web Crypto) and read back with the
// service role only; it is never an env var, never logged and never returned by any endpoint.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { getOrCreateVapid, type VapidKeys, type VapidStore } from "../_shared/webpush.ts";

export function vapidStore(sb: SupabaseClient): VapidStore {
  return {
    async read() {
      const { data, error } = await sb.from("push_vapid_snacc").select("public_key, private_jwk").eq("id", 1).maybeSingle();
      if (error) throw new Error(`push_vapid_snacc select: ${error.message}`);
      const row = data as { public_key?: string; private_jwk?: JsonWebKey } | null;
      return row?.public_key && row.private_jwk ? { publicKey: row.public_key, privateJwk: row.private_jwk } : null;
    },
    async insertIfAbsent(keys) {
      const { error } = await sb
        .from("push_vapid_snacc")
        .upsert({ id: 1, public_key: keys.publicKey, private_jwk: keys.privateJwk }, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw new Error(`push_vapid_snacc insert: ${error.message}`);
    },
  };
}

let cached: Promise<VapidKeys> | null = null;

/** The VAPID key pair, memoised per isolate; a failed attempt is not cached. */
export function loadVapid(sb: SupabaseClient): Promise<VapidKeys> {
  if (!cached) {
    cached = getOrCreateVapid(vapidStore(sb)).catch((e) => {
      cached = null;
      throw e;
    });
  }
  return cached;
}
