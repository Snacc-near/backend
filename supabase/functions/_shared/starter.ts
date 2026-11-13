/** `starter-pack` core: one 0.3 testnet NEAR transfer per NEAR account, with a global daily cap. */

import { fail, ok, type HandlerResult } from "./http.ts";
import { FaucetOutcomeUnknownError, STARTER_AMOUNT_YOCTO } from "./near-tx.ts";
import type { PlannedNotification } from "./scan.ts";
import { utcDay } from "./rules.ts";

export const STARTER_DAILY_CAP = 100;
/** SEC-119: claims per hashed client IP per UTC day. */
export const STARTER_PER_IP_DAILY_CAP = 3;

export interface StarterStore {
  nearAccountIdOf(userId: string): Promise<string | null>;
  existingClaim(accountId: string): Promise<{ tx_hash: string | null } | null>;
  /** Insert the claim row (tx_hash null); false when a row for this account already exists. */
  reserveClaim(row: { near_account_id: string; user_id: string; amount_yocto: string; ip_hash: string | null }): Promise<boolean>;
  /** Claims created at or after `sinceIso` (includes reservations). */
  claimsSince(sinceIso: string): Promise<number>;
  /** Claims created at or after `sinceIso` with this hashed client IP (includes reservations). */
  claimsFromIpSince(ipHash: string, sinceIso: string): Promise<number>;
  releaseClaim(accountId: string): Promise<void>;
  completeClaim(accountId: string, txHash: string): Promise<void>;
  insertNotification(n: PlannedNotification): Promise<void>;
}

export interface StarterDeps {
  store: StarterStore;
  /** `null` when `SNACC_FAUCET_ACCOUNT_ID` / `SNACC_FAUCET_PRIVATE_KEY` are not set. */
  sendTransfer: ((receiverId: string, depositYocto: bigint) => Promise<string>) | null;
  viewAccount: (accountId: string) => Promise<{ amount: string } | null>;
  now?: () => number;
  dailyCap?: number;
  /** SEC-119: HMAC of the client IP (`hashClientIp`), never the raw IP. Absent/`null` skips the per-IP cap. */
  ipHash?: string | null;
  perIpDailyCap?: number;
  /** SEC-119: optional captcha check (Cloudflare Turnstile); `null` = captcha disabled. */
  verifyCaptcha?: (() => Promise<boolean>) | null;
}

/** First address of `x-forwarded-for` (set by the Supabase edge), else `cf-connecting-ip`/`x-real-ip`, else "unknown". */
export function clientIp(headers: { get(name: string): string | null }): string {
  const xff = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return xff || headers.get("cf-connecting-ip")?.trim() || headers.get("x-real-ip")?.trim() || "unknown";
}

/** HMAC-SHA256(key, ip) as 64 hex chars, so the raw IP is never stored. */
export async function hashClientIp(ip: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key || "snacc-ip-v1"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`snacc-starter-ip:${ip}`)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cloudflare Turnstile server-side check; any network/parse failure counts as failed. */
export async function verifyTurnstile(
  secret: string,
  token: string | null,
  ip: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) return false;
  const form = new URLSearchParams({ secret, response: token });
  if (ip !== "unknown") form.set("remoteip", ip);
  try {
    const res = await fetchFn("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    if (!res.ok) return false;
    const body = (await res.json()) as { success?: unknown };
    return body.success === true;
  } catch {
    return false;
  }
}

/** POST /starter-pack for the authenticated `userId`. */
export async function handleStarterPack(userId: string, deps: StarterDeps): Promise<HandlerResult> {
  if (!deps.sendTransfer) return fail(503, "not_configured", "The starter pack faucet is not configured.");
  if (deps.verifyCaptcha && !(await deps.verifyCaptcha())) {
    return fail(403, "captcha_failed", "The captcha check failed. Reload the page and try again.");
  }
  const accountId = await deps.store.nearAccountIdOf(userId);
  if (!accountId) return fail(403, "no_profile", "Sign in with NEAR first.");

  const prior = await deps.store.existingClaim(accountId);
  if (prior) return fail(409, "already_claimed", "This NEAR account already received its starter pack.", { txHash: prior.tx_hash });

  let balance: bigint;
  try {
    const acct = await deps.viewAccount(accountId);
    balance = acct ? BigInt(acct.amount) : 0n;
  } catch {
    return fail(503, "rpc_unavailable", "Could not reach NEAR RPC. Try again.");
  }
  if (balance >= STARTER_AMOUNT_YOCTO) {
    return fail(409, "balance_sufficient", "Your account already holds at least 0.3 testnet NEAR.");
  }

  const amount = STARTER_AMOUNT_YOCTO.toString();
  if (!(await deps.store.reserveClaim({ near_account_id: accountId, user_id: userId, amount_yocto: amount, ip_hash: deps.ipHash ?? null }))) {
    return fail(409, "already_claimed", "This NEAR account already received its starter pack.");
  }
  const now = (deps.now ?? Date.now)();
  const dayStart = `${utcDay(now)}T00:00:00.000Z`;
  if ((await deps.store.claimsSince(dayStart)) > (deps.dailyCap ?? STARTER_DAILY_CAP)) {
    await deps.store.releaseClaim(accountId);
    return fail(429, "daily_cap_reached", "Today's starter packs are gone. Try again tomorrow (UTC).");
  }
  // Counted after the reservation (like the global cap) so parallel requests cannot slip past it.
  if (deps.ipHash && (await deps.store.claimsFromIpSince(deps.ipHash, dayStart)) > (deps.perIpDailyCap ?? STARTER_PER_IP_DAILY_CAP)) {
    await deps.store.releaseClaim(accountId);
    return fail(429, "ip_cap_reached", "Too many starter packs from this network today. Try again tomorrow (UTC).");
  }

  let txHash: string;
  try {
    txHash = await deps.sendTransfer(accountId, STARTER_AMOUNT_YOCTO);
  } catch (e) {
    if (e instanceof FaucetOutcomeUnknownError) {
      // Keep the reservation so a retry cannot pay twice; record the hash for manual follow-up.
      await deps.store.completeClaim(accountId, e.txHash);
      return fail(502, "transfer_unknown", "The faucet transfer was sent but not confirmed. Check your balance shortly.", { txHash: e.txHash });
    }
    await deps.store.releaseClaim(accountId);
    console.error("starter-pack: transfer failed", e instanceof Error ? e.message.slice(0, 200) : "unknown error");
    return fail(502, "transfer_failed", "The faucet transfer failed. Try again later.");
  }
  await deps.store.completeClaim(accountId, txHash);
  await deps.store.insertNotification({
    user_id: userId,
    kind: "starter",
    strain_id: null,
    title: "Starter pack sent",
    body: "0.3 testnet NEAR is on its way to your account (testnet NEAR has no monetary value).",
    dedupe_key: `starter:${accountId}`,
  });
  return ok({ claimed: true, txHash, amountYocto: amount });
}
