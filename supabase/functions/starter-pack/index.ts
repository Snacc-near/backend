// starter-pack (deploy with verify_jwt = true)
//   POST /starter-pack + Authorization: Bearer <user access token>
//   -> { claimed: true, txHash, amountYocto }   (0.3 testnet NEAR, once per NEAR account, max 100 per UTC day)
// Secrets: SNACC_FAUCET_ACCOUNT_ID, SNACC_FAUCET_PRIVATE_KEY (missing -> 503 not_configured). The key is never logged.
// SEC-119: max 3 claims per hashed client IP per UTC day (SNACC_IP_HASH_KEY, default: the service role key);
// optional Cloudflare Turnstile when SNACC_TURNSTILE_SECRET is set (body {"turnstileToken": "..."}).
import { fail, preflight, toResponse } from "../_shared/http.ts";
import { NearRpc } from "../_shared/near-rpc.ts";
import { makeFaucetSender } from "../_shared/near-tx.ts";
import { clientIp, handleStarterPack, hashClientIp, verifyTurnstile, type StarterStore } from "../_shared/starter.ts";
import { callerUserId, env, guarded, nearAccountIdOf, serviceClient } from "../_deno/db.ts";

const sb = serviceClient();
const rpc = new NearRpc();
const faucetAccount = env("SNACC_FAUCET_ACCOUNT_ID");
const faucetKey = env("SNACC_FAUCET_PRIVATE_KEY");
const sendTransfer = faucetAccount && faucetKey ? makeFaucetSender(rpc, faucetAccount, faucetKey) : null;
const ipHashKey = env("SNACC_IP_HASH_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const turnstileSecret = env("SNACC_TURNSTILE_SECRET");

/** `turnstileToken` from a JSON body; a missing or non-JSON body gives null (captcha then fails). */
async function turnstileToken(req: Request): Promise<string | null> {
  try {
    const body = (await req.json()) as { turnstileToken?: unknown };
    return typeof body.turnstileToken === "string" && body.turnstileToken.length <= 4096 ? body.turnstileToken : null;
  } catch {
    return null;
  }
}

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

const store: StarterStore = {
  nearAccountIdOf: (userId) => nearAccountIdOf(sb, userId),
  async existingClaim(accountId) {
    const { data, error } = await sb.from("starter_claims_snacc").select("tx_hash").eq("near_account_id", accountId).maybeSingle();
    check(error, "starter_claims_snacc select");
    return (data as { tx_hash: string | null } | null) ?? null;
  },
  async reserveClaim(row) {
    const { data, error } = await sb
      .from("starter_claims_snacc")
      .upsert(row, { onConflict: "near_account_id", ignoreDuplicates: true })
      .select("near_account_id");
    check(error, "starter_claims_snacc reserve");
    return (data?.length ?? 0) === 1;
  },
  async claimsSince(sinceIso) {
    const { count, error } = await sb.from("starter_claims_snacc").select("near_account_id", { count: "exact", head: true }).gte("created_at", sinceIso);
    check(error, "starter_claims_snacc count");
    return count ?? 0;
  },
  async claimsFromIpSince(ipHash, sinceIso) {
    const { count, error } = await sb
      .from("starter_claims_snacc")
      .select("near_account_id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", sinceIso);
    check(error, "starter_claims_snacc ip count");
    return count ?? 0;
  },
  async releaseClaim(accountId) {
    const { error } = await sb.from("starter_claims_snacc").delete().eq("near_account_id", accountId).is("tx_hash", null);
    check(error, "starter_claims_snacc release");
  },
  async completeClaim(accountId, txHash) {
    const { error } = await sb.from("starter_claims_snacc").update({ tx_hash: txHash }).eq("near_account_id", accountId);
    check(error, "starter_claims_snacc complete");
  },
  async insertNotification(n) {
    const { error } = await sb.from("notifications_snacc").upsert(n, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true });
    check(error, "notifications_snacc insert");
  },
};

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  const origin = req.headers.get("origin");
  if (req.method !== "POST") return toResponse(fail(405, "method_not_allowed", "Use POST."), origin);
  return guarded("starter-pack", origin, async () => {
    if (!sendTransfer) return fail(503, "not_configured", "The starter pack faucet is not configured.");
    const userId = await callerUserId(sb, req);
    if (!userId) return fail(401, "unauthorized", "Missing or invalid session token.");
    const ip = clientIp(req.headers);
    const ipHash = await hashClientIp(ip, ipHashKey);
    const verifyCaptcha = turnstileSecret ? async () => verifyTurnstile(turnstileSecret, await turnstileToken(req), ip) : null;
    return handleStarterPack(userId, { store, sendTransfer, viewAccount: (accountId) => rpc.viewAccount(accountId), ipHash, verifyCaptcha });
  });
});
