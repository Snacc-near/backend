// near-auth (deploy with verify_jwt = false)
//   POST /near-auth/challenge { accountId }                                   -> { nonce, message, recipient, expiresAt }
//   POST /near-auth/verify    { accountId, publicKey, signature, nonce, message, recipient } -> { tokenHash, type, nearAccountId }
// The frontend then calls supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" }).
import { handleChallenge, handleVerify, type AuthDeps, type AuthStore, type NonceRow } from "../_shared/auth.ts";
import { fail, preflight, readJsonObject, toResponse } from "../_shared/http.ts";
import { NearRpc } from "../_shared/near-rpc.ts";
import { env, guarded, serviceClient } from "../_deno/db.ts";

const sb = serviceClient();
const rpc = new NearRpc();

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

const store: AuthStore = {
  async insertNonce(row) {
    const { error } = await sb.from("auth_nonces_snacc").insert(row);
    check(error, "auth_nonces_snacc insert");
    // best-effort housekeeping of long-expired challenges
    await sb.from("auth_nonces_snacc").delete().lt("expires_at", new Date(Date.now() - 86_400_000).toISOString());
  },
  async getNonce(nonce) {
    const { data, error } = await sb.from("auth_nonces_snacc").select("nonce, account_id, expires_at, used_at").eq("nonce", nonce).maybeSingle();
    check(error, "auth_nonces_snacc select");
    return (data as NonceRow | null) ?? null;
  },
  async consumeNonce(nonce, accountId, nowIso) {
    const { data, error } = await sb
      .from("auth_nonces_snacc")
      .update({ used_at: nowIso })
      .eq("nonce", nonce)
      .eq("account_id", accountId)
      .is("used_at", null)
      .gt("expires_at", nowIso)
      .select("nonce");
    check(error, "auth_nonces_snacc consume");
    return (data?.length ?? 0) === 1;
  },
  async findUserIdByAccount(accountId) {
    const { data, error } = await sb.from("profiles_snacc").select("user_id").eq("near_account_id", accountId).maybeSingle();
    check(error, "profiles_snacc select");
    return (data as { user_id?: string } | null)?.user_id ?? null;
  },
  async createUser(email, accountId) {
    const { error } = await sb.auth.admin.createUser({ email, email_confirm: true, user_metadata: { near_account_id: accountId } });
    if (!error) return "created";
    const code = (error as { code?: string }).code;
    if (code === "email_exists" || code === "user_already_exists" || /already (been )?registered|already exists/i.test(error.message)) return "exists";
    throw new Error(`createUser: ${error.message}`);
  },
  async generateMagicLink(email) {
    const { data, error } = await sb.auth.admin.generateLink({ type: "magiclink", email });
    const hashed = data?.properties?.hashed_token;
    if (error || !hashed || !data?.user?.id) throw new Error(`generateLink: ${error?.message ?? "no hashed_token"}`);
    return { userId: data.user.id, hashedToken: hashed };
  },
  async upsertProfile(userId, accountId) {
    const { error } = await sb
      .from("profiles_snacc")
      .upsert({ user_id: userId, near_account_id: accountId }, { onConflict: "user_id", ignoreDuplicates: true });
    check(error, "profiles_snacc upsert");
  },
};

const deps: AuthDeps = {
  store,
  viewAccessKey: (accountId, publicKey) => rpc.viewAccessKey(accountId, publicKey),
  emailDomain: env("SNACC_AUTH_EMAIL_DOMAIN"),
};

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  const origin = req.headers.get("origin");
  if (req.method !== "POST") return toResponse(fail(405, "method_not_allowed", "Use POST."), origin);
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (path.endsWith("/challenge")) return guarded("near-auth", origin, async () => handleChallenge(await readJsonObject(req), deps));
  if (path.endsWith("/verify")) return guarded("near-auth", origin, async () => handleVerify(await readJsonObject(req), deps));
  return toResponse(fail(404, "not_found", "Use POST /near-auth/challenge or /near-auth/verify."), origin);
});
