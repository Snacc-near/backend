// starter-pack (deploy with verify_jwt = true)
//   POST /starter-pack + Authorization: Bearer <user access token>
//   -> { claimed: true, txHash, amountYocto }   (0.3 testnet NEAR, once per NEAR account, max 100 per UTC day)
// Secrets: SNACC_FAUCET_ACCOUNT_ID, SNACC_FAUCET_PRIVATE_KEY (missing -> 503 not_configured). The key is never logged.
import { fail, preflight, toResponse } from "../_shared/http.ts";
import { NearRpc } from "../_shared/near-rpc.ts";
import { makeFaucetSender } from "../_shared/near-tx.ts";
import { handleStarterPack, type StarterStore } from "../_shared/starter.ts";
import { callerUserId, env, guarded, nearAccountIdOf, serviceClient } from "../_deno/db.ts";

const sb = serviceClient();
const rpc = new NearRpc();
const faucetAccount = env("SNACC_FAUCET_ACCOUNT_ID");
const faucetKey = env("SNACC_FAUCET_PRIVATE_KEY");
const sendTransfer = faucetAccount && faucetKey ? makeFaucetSender(rpc, faucetAccount, faucetKey) : null;

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
    return handleStarterPack(userId, { store, sendTransfer, viewAccount: (accountId) => rpc.viewAccount(accountId) });
  });
});
