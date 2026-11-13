// record-tx (deploy with verify_jwt = true)
//   POST /record-tx { txHash } + Authorization: Bearer <user access token>
//   -> { recorded: true, method, achievements: [codes newly earned] }
import { fail, preflight, readJsonObject, toResponse } from "../_shared/http.ts";
import { NearRpc, resolveContractId } from "../_shared/near-rpc.ts";
import { handleRecordTx, type RecordStore } from "../_shared/record.ts";
import { callerUserId, env, guarded, nearAccountIdOf, serviceClient } from "../_deno/db.ts";

const sb = serviceClient();
const rpc = new NearRpc();
const contractId = resolveContractId(env);

const store: RecordStore = {
  nearAccountIdOf: (userId) => nearAccountIdOf(sb, userId),
  async achievementCodes(userId) {
    const { data, error } = await sb.from("achievements_snacc").select("code").eq("user_id", userId);
    if (error) throw new Error(`achievements_snacc: ${error.message}`);
    return ((data ?? []) as Array<{ code: string }>).map((r) => r.code);
  },
  async insertActivity(row) {
    // AFTER INSERT trigger snacc_award_achievements() runs only for a newly inserted tx_hash.
    const { data, error } = await sb.from("activity_snacc").upsert(row, { onConflict: "tx_hash", ignoreDuplicates: true }).select("tx_hash");
    if (error) throw new Error(`activity_snacc: ${error.message}`);
    return (data?.length ?? 0) > 0;
  },
};

Deno.serve(async (req: Request) => {
  const pre = preflight(req);
  if (pre) return pre;
  const origin = req.headers.get("origin");
  if (req.method !== "POST") return toResponse(fail(405, "method_not_allowed", "Use POST."), origin);
  return guarded("record-tx", origin, async () => {
    const userId = await callerUserId(sb, req);
    if (!userId) return fail(401, "unauthorized", "Missing or invalid session token.");
    return handleRecordTx(userId, await readJsonObject(req), {
      store,
      contractId,
      txStatus: (txHash, senderId) => rpc.txStatus(txHash, senderId, "FINAL"),
      blockTimestampMs: (blockHash) => rpc.blockTimestampMs(blockHash),
    });
  });
});
