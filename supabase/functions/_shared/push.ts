/**
 * `push` + `push-dispatch` core (UI-160), independent of Deno and supabase-js: the Edge Functions wire a
 * Postgres-backed store, the tests use fakes.
 *
 *  - subscription validation (https endpoint on a known push service, key shapes) and the subscribe /
 *    unsubscribe handlers
 *  - the payload a notification becomes (`{title, body, url, tag}`)
 *  - dispatch planning (which notifications to claim, which sends to make, within a cap)
 *  - turning delivery results into subscription updates (drop on 404/410, count other failures)
 */

import { fail, ok, type HandlerResult } from "./http.ts";
import { b64uDecode, b64uEncode, isValidP256PublicKey, type SendOutcome } from "./webpush.ts";

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------

export const MAX_BODY_BYTES = 4096;
export const MAX_ENDPOINT_LENGTH = 2048;
export const MAX_USER_AGENT_LENGTH = 120;
/** One player can register this many devices; the next one is refused until they remove one. */
export const MAX_SUBSCRIPTIONS_PER_USER = 10;
/** A subscription is dropped after this many consecutive failed runs (404/410 drops it at once). */
export const MAX_FAILURES = 10;

// ---------------------------------------------------------------------------------------------
// Endpoint validation
// ---------------------------------------------------------------------------------------------

/** Push services the browsers use: Chrome/Edge/Brave/Opera (FCM, WNS), Firefox (autopush), Safari (APNs web push). */
export const PUSH_HOSTS: readonly string[] = ["fcm.googleapis.com", "web.push.apple.com", "updates.push.services.mozilla.com"];
export const PUSH_HOST_SUFFIXES: readonly string[] = [".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"];

/**
 * True only for `https://<known push service host>/<path>`: no userinfo, no port, no fragment, no IP literal,
 * bounded length. The dispatcher re-checks this before every POST, so a row inserted straight into the table
 * can never make the backend call an arbitrary host.
 */
export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length < 20 || endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  if (/[\s\\]/.test(endpoint)) return false;
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.port !== "" || u.hash !== "") return false;
  if (u.pathname.length < 2) return false;
  const host = u.hostname;
  if (/^[0-9.]+$/.test(host) || host.includes(":") || host.endsWith(".")) return false;
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

export interface ValidSubscription {
  endpoint: string;
  /** Canonical (unpadded) base64url of the 65-byte `p256dh`. */
  p256dh: string;
  /** Canonical (unpadded) base64url of the 16-byte `auth`. */
  auth: string;
}

/** Shape check of a browser `PushSubscription.toJSON()`; the `p256dh` point is also checked to be on the curve. */
export async function parseSubscription(body: Record<string, unknown> | null): Promise<ValidSubscription | HandlerResult> {
  if (!body) return fail(400, "bad_request", "Expected a JSON object body.");
  const { endpoint, keys } = body;
  if (!isAllowedPushEndpoint(endpoint)) {
    return fail(400, "invalid_endpoint", "endpoint must be an https URL on a known browser push service.");
  }
  const k = keys && typeof keys === "object" && !Array.isArray(keys) ? (keys as Record<string, unknown>) : null;
  const p256dh = typeof k?.["p256dh"] === "string" ? b64uDecode(k["p256dh"]) : null;
  const auth = typeof k?.["auth"] === "string" ? b64uDecode(k["auth"]) : null;
  if (!p256dh || !(await isValidP256PublicKey(p256dh))) return fail(400, "invalid_keys", "keys.p256dh must be a base64url P-256 public key (65 bytes).");
  if (!auth || auth.length !== 16) return fail(400, "invalid_keys", "keys.auth must be base64url of 16 bytes.");
  return { endpoint, p256dh: b64uEncode(p256dh), auth: b64uEncode(auth) };
}

function isHandlerResult(v: ValidSubscription | HandlerResult): v is HandlerResult {
  return "status" in v && "body" in v;
}

export function shortUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  // eslint-disable-next-line no-control-regex
  const clean = ua.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_USER_AGENT_LENGTH);
  return clean === "" ? null : clean;
}

// ---------------------------------------------------------------------------------------------
// Subscribe / unsubscribe / key handlers
// ---------------------------------------------------------------------------------------------

export interface PushRow {
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string | null;
}

export interface PushStore {
  /** Number of the player's subscriptions whose endpoint differs from `exceptEndpoint`. */
  countOthers(userId: string, exceptEndpoint: string): Promise<number>;
  /** Insert, or take over an existing row with the same endpoint (a device now used by another signed-in player). Resets `failures`. */
  upsert(row: PushRow): Promise<void>;
  /** Delete the player's own subscription for `endpoint`; the number of rows removed. */
  deleteOwn(userId: string, endpoint: string): Promise<number>;
}

/** POST /push/subscribe `{ endpoint, keys: { p256dh, auth } }` (a browser `PushSubscription.toJSON()`). */
export async function handleSubscribe(userId: string, body: Record<string, unknown> | null, userAgent: string | null, store: PushStore): Promise<HandlerResult> {
  const sub = await parseSubscription(body);
  if (isHandlerResult(sub)) return sub;
  if ((await store.countOthers(userId, sub.endpoint)) >= MAX_SUBSCRIPTIONS_PER_USER) {
    return fail(409, "too_many_subscriptions", `At most ${MAX_SUBSCRIPTIONS_PER_USER} devices can receive push notifications. Turn it off on one of them first.`);
  }
  await store.upsert({ user_id: userId, endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth, user_agent: shortUserAgent(userAgent) });
  return ok({ subscribed: true }, 201);
}

/** POST /push/unsubscribe `{ endpoint }`: idempotent, only ever removes the caller's own row. */
export async function handleUnsubscribe(userId: string, body: Record<string, unknown> | null, store: PushStore): Promise<HandlerResult> {
  if (!body) return fail(400, "bad_request", "Expected a JSON object body.");
  const endpoint = body["endpoint"];
  if (typeof endpoint !== "string" || endpoint.length < 20 || endpoint.length > MAX_ENDPOINT_LENGTH) {
    return fail(400, "invalid_endpoint", "endpoint must be the push subscription URL.");
  }
  const removed = await store.deleteOwn(userId, endpoint);
  return ok({ unsubscribed: true, removed });
}

// ---------------------------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------------------------

/** The notification columns the dispatcher reads. */
export interface DispatchNotification {
  id: number;
  user_id: string;
  kind: string;
  strain_id: number | string | null;
  title: string;
  body: string | null;
  created_at: string;
}

/** What the service worker receives. `url` is a same-origin path; `tag` matches the in-page alert so the two collapse. */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** `/app?feed=<strain id>` (UI-159 deep link) for a hungry Snacc, `/app` otherwise. */
export function pushUrlFor(n: Pick<DispatchNotification, "kind" | "strain_id">): string {
  if (n.kind === "starving" || n.kind === "distressed") {
    const id = n.strain_id === null ? NaN : Number(n.strain_id);
    if (Number.isInteger(id) && id >= 0 && id <= 999_999_999) return `/app?feed=${id}`;
  }
  return "/app";
}

export function buildPayload(n: DispatchNotification): PushPayload {
  return {
    title: n.title.slice(0, 120),
    body: (n.body ?? "").slice(0, 200),
    url: pushUrlFor(n),
    tag: `snacc-${n.id}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Dispatch planning
// ---------------------------------------------------------------------------------------------

export interface DispatchSub {
  id: number;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failures: number;
}

export interface PlanInput {
  /** Unpushed notifications, oldest first. */
  notifications: readonly DispatchNotification[];
  subs: readonly DispatchSub[];
  nowMs: number;
  /** Notifications older than this are not pushed (they are marked as handled without a send). */
  maxAgeMs: number;
  /** At most this many sends in one plan; the notifications that do not fit are left for the next run. */
  maxSends: number;
}

export interface SendJob {
  notificationId: number;
  sub: DispatchSub;
  payload: PushPayload;
}

export interface DispatchPlan {
  /** Notifications to claim now (set `pushed_at`); anything not listed here stays unpushed for the next run. */
  claimIds: number[];
  jobs: SendJob[];
  /** Of `claimIds`: nothing to send (the player has no device subscribed, or it is stale). */
  skipped: { noSubscription: number; stale: number };
  /** Notifications left for a later run because the send cap was reached. */
  deferred: number;
}

export const DISPATCH_MAX_AGE_MS = 30 * 60_000;

export function planDispatch(input: PlanInput): DispatchPlan {
  const byUser = new Map<string, DispatchSub[]>();
  for (const s of input.subs) {
    if (!isAllowedPushEndpoint(s.endpoint) || s.failures >= MAX_FAILURES) continue;
    const list = byUser.get(s.user_id);
    if (list) list.push(s);
    else byUser.set(s.user_id, [s]);
  }
  const plan: DispatchPlan = { claimIds: [], jobs: [], skipped: { noSubscription: 0, stale: 0 }, deferred: 0 };
  let capped = false;
  for (const n of input.notifications) {
    // Notifications that need no send never consume the cap, so they are always claimed.
    const age = input.nowMs - Date.parse(n.created_at);
    if (!(age <= input.maxAgeMs)) {
      plan.claimIds.push(n.id);
      plan.skipped.stale++;
      continue;
    }
    const subs = byUser.get(n.user_id) ?? [];
    if (subs.length === 0) {
      plan.claimIds.push(n.id);
      plan.skipped.noSubscription++;
      continue;
    }
    // Once the cap is hit, every later notification that needs a send waits for the next run (order is kept).
    if (capped || (plan.jobs.length > 0 && plan.jobs.length + subs.length > input.maxSends)) {
      capped = true;
      plan.deferred++;
      continue;
    }
    plan.claimIds.push(n.id);
    const payload = buildPayload(n);
    for (const sub of subs) plan.jobs.push({ notificationId: n.id, sub, payload });
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Outcomes -> subscription updates
// ---------------------------------------------------------------------------------------------

export interface JobResult {
  sub: DispatchSub;
  outcome: SendOutcome;
}

export interface OutcomePlan {
  /** Subscriptions to delete (push service said gone, or too many consecutive failures). */
  remove: number[];
  /** Subscriptions that delivered at least once: `last_ok_at = now`, `failures = 0`. */
  ok: number[];
  /** Subscriptions that only failed this run: set `failures` to the given value. */
  failed: Array<{ id: number; failures: number }>;
}

/** One verdict per subscription per run: gone wins, then any success, otherwise one more failure. */
export function planOutcomes(results: readonly JobResult[]): OutcomePlan {
  const perSub = new Map<number, { sub: DispatchSub; gone: boolean; ok: boolean }>();
  for (const r of results) {
    const cur = perSub.get(r.sub.id) ?? { sub: r.sub, gone: false, ok: false };
    if (r.outcome.kind === "gone") cur.gone = true;
    else if (r.outcome.kind === "ok") cur.ok = true;
    perSub.set(r.sub.id, cur);
  }
  const out: OutcomePlan = { remove: [], ok: [], failed: [] };
  for (const [id, v] of perSub) {
    if (v.gone) out.remove.push(id);
    else if (v.ok) out.ok.push(id);
    else if (v.sub.failures + 1 >= MAX_FAILURES) out.remove.push(id);
    else out.failed.push({ id, failures: v.sub.failures + 1 });
  }
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight; stops starting new items once `shouldStop()` is true. */
export async function runPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>, shouldStop: () => boolean = () => false): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length && !shouldStop()) {
      const item = items[next++] as T;
      out.push(await fn(item));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
