// notify-scan (deploy with verify_jwt = false; requires header x-cron-secret = Vault secret snacc_cron_secret)
// Scans up to SNACC_SCAN_MAX_PROFILES profiles (default 50, least recently scanned first) and inserts
// starving / distressed / lost notifications into notifications_snacc (deduplicated per kind/strain/UTC day).
import { fail, ok, safeEqual, toResponse } from "../_shared/http.ts";
import { NearRpc, resolveContractId } from "../_shared/near-rpc.ts";
import {
  DEFAULT_PREFS,
  missingFromListing,
  planScan,
  readOwnedStrains,
  readStrainOrNull,
  type NotificationPrefs,
  type ScanMemory,
  type StrainSnapshot,
  type ViewFn,
} from "../_shared/scan.ts";
import { env, guarded, serviceClient } from "../_deno/db.ts";

const sb = serviceClient();
const rpc = new NearRpc();
const contractId = resolveContractId(env);
const view: ViewFn = (method, args) => rpc.callView(contractId, method, args);

/** Stop starting new profiles after this long so the run ends inside the Edge wall-clock limit. */
const TIME_BUDGET_MS = 50_000;

function maxProfiles(): number {
  const n = Number(env("SNACC_SCAN_MAX_PROFILES") ?? 50);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 50;
}

interface QueueRow {
  user_id: string;
  near_account_id: string;
  scanned_at: string | null;
  strains: ScanMemory | null;
}

async function scan(): Promise<Record<string, number>> {
  const started = Date.now();
  const counts = { profiles: 0, strains: 0, planned: 0, inserted: 0, errors: 0, skipped: 0 };
  const { data: queue, error } = await sb
    .from("scan_queue_snacc")
    .select("user_id, near_account_id, scanned_at, strains")
    .order("scanned_at", { ascending: true, nullsFirst: true })
    .limit(maxProfiles());
  if (error) throw new Error(`scan_queue_snacc: ${error.message}`);
  const rows = (queue ?? []) as QueueRow[];

  const prefs = new Map<string, NotificationPrefs>();
  if (rows.length > 0) {
    const { data: p, error: pe } = await sb
      .from("notification_prefs_snacc")
      .select("user_id, starving, distressed, lost, dividend, starter, system")
      .in("user_id", rows.map((r) => r.user_id));
    if (pe) throw new Error(`notification_prefs_snacc: ${pe.message}`);
    for (const r of (p ?? []) as Array<NotificationPrefs & { user_id: string }>) prefs.set(r.user_id, r);
  }

  for (const q of rows) {
    if (Date.now() - started > TIME_BUDGET_MS) {
      counts.skipped++;
      continue;
    }
    const previous: ScanMemory | null = q.scanned_at ? (q.strains ?? {}) : null;
    let memory: ScanMemory = previous ?? {};
    try {
      const current = await readOwnedStrains(view, q.near_account_id);
      const recheck: Record<string, StrainSnapshot | null> = {};
      for (const id of missingFromListing(previous, current)) recheck[id] = await readStrainOrNull(view, id);
      const plan = planScan({
        userId: q.user_id,
        accountId: q.near_account_id,
        current,
        previous,
        recheck,
        prefs: prefs.get(q.user_id) ?? DEFAULT_PREFS,
        nowMs: Date.now(),
      });
      if (plan.notifications.length > 0) {
        const { data, error: ne } = await sb
          .from("notifications_snacc")
          .upsert(plan.notifications, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true })
          .select("id");
        if (ne) throw new Error(`notifications_snacc: ${ne.message}`);
        counts.inserted += data?.length ?? 0;
      }
      memory = plan.memory;
      counts.profiles++;
      counts.strains += current.length;
      counts.planned += plan.notifications.length;
    } catch (e) {
      counts.errors++;
      console.error("notify-scan: profile failed", q.user_id, e instanceof Error ? e.message.slice(0, 200) : "unknown");
    }
    // Always advance scanned_at so one failing profile cannot starve the queue.
    const { error: se } = await sb
      .from("scan_state_snacc")
      .upsert({ user_id: q.user_id, near_account_id: q.near_account_id, strains: memory, scanned_at: new Date().toISOString() }, { onConflict: "user_id" });
    if (se) console.error("notify-scan: scan_state_snacc upsert failed", se.message);
  }
  console.log(JSON.stringify({ fn: "notify-scan", ms: Date.now() - started, queue: rows.length, ...counts }));
  return counts;
}

/**
 * OPS-128: the cron secret lives in Supabase Vault (migration 20261113000005). An explicit
 * SNACC_CRON_SECRET edge secret still wins when set, so older setups keep working.
 */
async function cronSecretCheck(got: string): Promise<"ok" | "bad" | "unavailable"> {
  if (!got) return "bad";
  const secret = env("SNACC_CRON_SECRET");
  if (secret) return safeEqual(got, secret) ? "ok" : "bad";
  const { data, error } = await sb.rpc("snacc_cron_secret_ok", { candidate: got });
  if (error) {
    console.error("notify-scan: snacc_cron_secret_ok failed", error.message);
    return "unavailable";
  }
  return data === true ? "ok" : "bad";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return toResponse(fail(405, "method_not_allowed", "Use POST."), null, false);
  const check = await cronSecretCheck(req.headers.get("x-cron-secret") ?? "");
  if (check === "unavailable") {
    return toResponse(fail(503, "not_configured", "Cron secret check is unavailable (Vault function missing)."), null, false);
  }
  if (check === "bad") {
    return toResponse(fail(401, "unauthorized", "Missing or wrong x-cron-secret."), null, false);
  }
  return guarded("notify-scan", null, async () => ok(await scan()), false);
});
