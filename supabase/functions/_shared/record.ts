/** `record-tx` core: verify a caller's Snacc transaction on-chain and record it in `activity_snacc`. */

import { fail, ok, type HandlerResult } from "./http.ts";
import { base58Decode } from "./nep413.ts";
import {
  NearRpcError,
  checkTxForAccount,
  extractStrainId,
  strainIdFromReturn,
  summarizeTxStatus,
  type TxCheckError,
} from "./near-rpc.ts";

export interface ActivityRow {
  tx_hash: string;
  user_id: string;
  near_account_id: string;
  method: string;
  strain_id: string | null;
  block_time: string;
}

export interface RecordStore {
  nearAccountIdOf(userId: string): Promise<string | null>;
  achievementCodes(userId: string): Promise<string[]>;
  /** Insert ignoring a duplicate `tx_hash`; true when a new row was written. */
  insertActivity(row: ActivityRow): Promise<boolean>;
}

export interface RecordDeps {
  store: RecordStore;
  txStatus: (txHash: string, senderId: string) => Promise<unknown>;
  blockTimestampMs: (blockHash: string) => Promise<number>;
  contractId: string;
  now?: () => number;
}

const TX_ERRORS: Record<TxCheckError, [number, string]> = {
  tx_signer_mismatch: [403, "The transaction was not signed by your NEAR account."],
  tx_wrong_receiver: [422, "The transaction was not sent to the Snacc contract."],
  tx_failed: [422, "The transaction failed on-chain."],
  tx_pending: [409, "The transaction is not final yet. Retry in a few seconds."],
  tx_not_function_call: [422, "The transaction has no contract call."],
};

/** POST /record-tx `{ txHash }` for the authenticated `userId`. */
export async function handleRecordTx(userId: string, body: Record<string, unknown> | null, deps: RecordDeps): Promise<HandlerResult> {
  if (!body) return fail(400, "bad_request", "Expected a JSON object body.");
  const txHash = body["txHash"];
  const raw = typeof txHash === "string" ? base58Decode(txHash) : null;
  if (typeof txHash !== "string" || !raw || raw.length !== 32) return fail(400, "invalid_tx_hash", "txHash must be a base58 transaction hash.");

  const accountId = await deps.store.nearAccountIdOf(userId);
  if (!accountId) return fail(403, "no_profile", "Sign in with NEAR first.");

  let result: unknown;
  try {
    result = await deps.txStatus(txHash, accountId);
  } catch (e) {
    if (e instanceof NearRpcError && e.causeName === "UNKNOWN_TRANSACTION") return fail(404, "tx_not_found", "Transaction not found for your account.");
    if (e instanceof NearRpcError && e.causeName === "TIMEOUT_ERROR") return fail(409, "tx_pending", TX_ERRORS.tx_pending[1]);
    return fail(503, "rpc_unavailable", "Could not reach NEAR RPC. Try again.");
  }
  const s = summarizeTxStatus(result);
  if (!s) return fail(502, "rpc_bad_response", "Unexpected transaction status shape from NEAR RPC.");
  const bad = checkTxForAccount(s, { accountId, contractId: deps.contractId });
  if (bad) {
    const [status, message] = TX_ERRORS[bad];
    return fail(status, bad, message);
  }
  const call = s.firstCall!;
  const strainId = extractStrainId(call.args) ?? (call.methodName === "incubate_strain" ? strainIdFromReturn(s.successValue) : null);

  let blockMs = (deps.now ?? Date.now)();
  if (s.blockHash) {
    try {
      blockMs = await deps.blockTimestampMs(s.blockHash);
    } catch {
      // keep "now": only affects the streak day when the RPC cannot serve the block
    }
  }

  const before = new Set(await deps.store.achievementCodes(userId));
  await deps.store.insertActivity({
    tx_hash: txHash,
    user_id: userId,
    near_account_id: accountId,
    method: call.methodName,
    strain_id: strainId,
    block_time: new Date(blockMs).toISOString(),
  });
  const after = await deps.store.achievementCodes(userId);
  return ok({ recorded: true, method: call.methodName, achievements: after.filter((c) => !before.has(c)) });
}
