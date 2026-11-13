// push-dispatch (deploy with verify_jwt = false; requires header x-cron-secret = Vault secret snacc_cron_secret) - UI-160
// Cron-driven (every minute, migration 20261113000008). Sends a Web Push for every notifications_snacc row that has
// pushed_at IS NULL to that player's push_subscriptions_snacc, then stamps pushed_at. One path covers every producer of
// notifications (notify-scan, starter pack, dividends, admin broadcast) and keeps notify-scan's time budget untouched.
//   - rows are CLAIMED (pushed_at set where it is still null) before sending, so overlapping runs never double-send;
//     delivery is at-most-once and best effort (the in-app inbox stays the source of truth)
//   - rows older than 30 minutes are not pushed (migration backfills old rows, so nothing historic is ever sent)
//   - 404/410 from the push service deletes the subscription; any other failure counts in failures (10 in a row deletes it)
//   - per run: chunks of 50 notifications, at most 200 sends per chunk, 8 sends in flight, 40 s time budget
import { fail, ok, toResponse } from "../_shared/http.ts";
import {
  DISPATCH_MAX_AGE_MS,
  MAX_FAILURES,
  planDispatch,
  planOutcomes,
  runPool,
  type DispatchNotification,
  type DispatchSub,
  type JobResult,
  type SendJob,
} from "../_shared/push.ts";
import { DEFAULT_VAPID_SUBJECT, audienceOf, sendWebPush, signVapidJwt, vapidAuthorization, type VapidKeys } from "../_shared/webpush.ts";
import { cronSecretCheck, env, guarded, serviceClient } from "../_deno/db.ts";
import { loadVapid } from "../_deno/vapid.ts";

const sb = serviceClient();
const subjectEnv = env("SNACC_VAPID_SUBJECT");
const subject = subjectEnv && /^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subjectEnv) ? subjectEnv : DEFAULT_VAPID_SUBJECT;

const TIME_BUDGET_MS = 40_000;
const CHUNK = 50;
const MAX_SENDS_PER_CHUNK = 200;
const CONCURRENCY = 8;

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

async function dispatch(): Promise<Record<string, unknown>> {
  const started = Date.now();
  const over = () => Date.now() - started > TIME_BUDGET_MS;
  const counts = { chunks: 0, claimed: 0, sent: 0, gone: 0, failed: 0, removed: 0, noSubscription: 0, stale: 0, deferred: 0 };
  const failuresByStatus: Record<string, number> = {};

  // Rows that aged out before we got to them are marked handled without a send.
  const cutoff = new Date(started - DISPATCH_MAX_AGE_MS).toISOString();
  const stale = await sb.from("notifications_snacc").update({ pushed_at: new Date(started).toISOString() }).is("pushed_at", null).lt("created_at", cutoff);
  check(stale.error, "notifications_snacc stale cleanup");

  let vapid: VapidKeys | null = null;
  const jwtByAudience = new Map<string, string>();
  const authorizationFor = async (endpoint: string): Promise<string> => {
    const aud = audienceOf(endpoint);
    let jwt = jwtByAudience.get(aud);
    if (!jwt) {
      jwt = await signVapidJwt({ audience: aud, subject, nowSec: Math.floor(Date.now() / 1000) }, (vapid as VapidKeys).privateJwk);
      jwtByAudience.set(aud, jwt);
    }
    return vapidAuthorization(jwt, (vapid as VapidKeys).publicKey);
  };
  const runJob = async (job: SendJob): Promise<JobResult> => ({
    sub: job.sub,
    outcome: await sendWebPush(job.sub, JSON.stringify(job.payload), { authorization: await authorizationFor(job.sub.endpoint) }),
  });

  while (!over()) {
    const { data: rows, error } = await sb
      .from("notifications_snacc")
      .select("id, user_id, kind, strain_id, title, body, created_at")
      .is("pushed_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(CHUNK);
    check(error, "notifications_snacc select");
    const notifications = (rows ?? []) as DispatchNotification[];
    if (notifications.length === 0) break;

    const userIds = [...new Set(notifications.map((n) => n.user_id))];
    const { data: subRows, error: se } = await sb
      .from("push_subscriptions_snacc")
      .select("id, user_id, endpoint, p256dh, auth, failures")
      .in("user_id", userIds)
      .lt("failures", MAX_FAILURES);
    check(se, "push_subscriptions_snacc select");

    const plan = planDispatch({ notifications, subs: (subRows ?? []) as DispatchSub[], nowMs: Date.now(), maxAgeMs: DISPATCH_MAX_AGE_MS, maxSends: MAX_SENDS_PER_CHUNK });
    counts.chunks++;
    counts.noSubscription += plan.skipped.noSubscription;
    counts.stale += plan.skipped.stale;
    counts.deferred += plan.deferred;
    if (plan.claimIds.length === 0) break;

    // Claim first: only rows still unpushed are ours, so an overlapping run cannot send the same push twice.
    const { data: claimedRows, error: ce } = await sb
      .from("notifications_snacc")
      .update({ pushed_at: new Date().toISOString() })
      .in("id", plan.claimIds)
      .is("pushed_at", null)
      .select("id");
    check(ce, "notifications_snacc claim");
    const claimed = new Set(((claimedRows ?? []) as Array<{ id: number }>).map((r) => r.id));
    counts.claimed += claimed.size;
    const jobs = plan.jobs.filter((j) => claimed.has(j.notificationId));

    if (jobs.length > 0) {
      vapid ??= await loadVapid(sb);
      const results = await runPool(jobs, CONCURRENCY, runJob, over);
      for (const r of results) {
        if (r.outcome.kind === "ok") counts.sent++;
        else if (r.outcome.kind === "gone") counts.gone++;
        else {
          counts.failed++;
          const key = String(r.outcome.status ?? "network");
          failuresByStatus[key] = (failuresByStatus[key] ?? 0) + 1;
        }
      }
      const outcomes = planOutcomes(results);
      const nowIso = new Date().toISOString();
      if (outcomes.remove.length > 0) {
        check((await sb.from("push_subscriptions_snacc").delete().in("id", outcomes.remove)).error, "push_subscriptions_snacc delete");
        counts.removed += outcomes.remove.length;
      }
      if (outcomes.ok.length > 0) {
        check((await sb.from("push_subscriptions_snacc").update({ last_ok_at: nowIso, failures: 0 }).in("id", outcomes.ok)).error, "push_subscriptions_snacc ok update");
      }
      const byFailures = new Map<number, number[]>();
      for (const f of outcomes.failed) byFailures.set(f.failures, [...(byFailures.get(f.failures) ?? []), f.id]);
      for (const [failures, ids] of byFailures) {
        check((await sb.from("push_subscriptions_snacc").update({ failures }).in("id", ids)).error, "push_subscriptions_snacc failure update");
      }
    }
    if (plan.deferred > 0) break; // cap reached: the rest goes in the next run
  }
  console.log(JSON.stringify({ fn: "push-dispatch", ms: Date.now() - started, ...counts, failuresByStatus }));
  return counts;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return toResponse(fail(405, "method_not_allowed", "Use POST."), null, false);
  const verdict = await cronSecretCheck(sb, "push-dispatch", req.headers.get("x-cron-secret") ?? "");
  if (verdict === "unavailable") {
    return toResponse(fail(503, "not_configured", "Cron secret check is unavailable (Vault function missing)."), null, false);
  }
  if (verdict === "bad") {
    return toResponse(fail(401, "unauthorized", "Missing or wrong x-cron-secret."), null, false);
  }
  return guarded("push-dispatch", null, async () => ok(await dispatch()), false);
});
