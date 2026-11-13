// NEAR RPC client + parsers shared by the Supabase Edge Functions, and the record-tx handler.
// Fixtures are real `EXPERIMENTAL_tx_status` answers for snacc-v001.testnet (archival testnet RPC):
// feed_strain CTxwJMyp8RaHwCtw8uRoY581hhSm2HW75DLMdb7n4xL, nft_transfer 88fJz3kdyzr1ZuHHxeNEVBEVNLNRBiFTRunVHnaQdsR5.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NearRpc,
  NearRpcError,
  TESTNET_RPC_URLS,
  checkTxForAccount,
  extractStrainId,
  parseAccessKeyPermission,
  resolveContractId,
  strainIdFromReturn,
  summarizeTxStatus,
} from "../supabase/functions/_shared/near-rpc.js";
import { handleRecordTx, type ActivityRow, type RecordStore } from "../supabase/functions/_shared/record.js";
import { computeAchievements } from "../supabase/functions/_shared/rules.js";

const CONTRACT = "snacc-v001.testnet";
const fixture = (name: string): { result: unknown } =>
  JSON.parse(readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8")) as { result: unknown };
const FEED = fixture("tx-status-feed_strain.json").result;
const TRANSFER = fixture("tx-status-nft_transfer.json").result;

type Handler = (url: string, body: { method: string; params: Record<string, unknown> }) => unknown;
function mockFetch(h: Handler, calls: string[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { method: string; params: Record<string, unknown> };
    calls.push(`${url} ${body.method}${body.params["request_type"] ? `:${String(body.params["request_type"])}` : ""}`);
    const out = h(url, body);
    if (out instanceof Error) throw out;
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out));
  }) as unknown as typeof fetch;
}
const rpcOk = (result: unknown) => ({ jsonrpc: "2.0", id: "snacc", result });
const handlerErr = (cause: string) => ({ jsonrpc: "2.0", id: "snacc", error: { name: "HANDLER_ERROR", cause: { name: cause, info: {} }, code: -32000, message: "Server error", data: cause } });

test("resolveContractId: default and SNACC_CONTRACT_ID override", () => {
  assert.equal(resolveContractId(() => undefined), CONTRACT);
  assert.equal(resolveContractId((k) => (k === "SNACC_CONTRACT_ID" ? " other.testnet " : undefined)), "other.testnet");
  assert.deepEqual(TESTNET_RPC_URLS, ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com"]);
});

test("parseAccessKeyPermission: FullAccess, FunctionCall, unknown", () => {
  assert.deepEqual(parseAccessKeyPermission("FullAccess"), { kind: "FullAccess" });
  assert.deepEqual(
    parseAccessKeyPermission({ FunctionCall: { allowance: "250000000000000000000000", receiver_id: CONTRACT, method_names: ["feed_strain"] } }),
    { kind: "FunctionCall", receiverId: CONTRACT, methodNames: ["feed_strain"], allowance: "250000000000000000000000" },
  );
  assert.deepEqual(parseAccessKeyPermission({ FunctionCall: { allowance: null, receiver_id: CONTRACT, method_names: [] } }), {
    kind: "FunctionCall",
    receiverId: CONTRACT,
    methodNames: [],
    allowance: null,
  });
  assert.deepEqual(parseAccessKeyPermission(null), { kind: "Unknown" });
  assert.deepEqual(parseAccessKeyPermission("Something"), { kind: "Unknown" });
});

test("NearRpc: falls back to the second endpoint on transport errors and INTERNAL_ERROR", async () => {
  const calls: string[] = [];
  const rpc = new NearRpc({
    fetchFn: mockFetch((url) => (url === TESTNET_RPC_URLS[0] ? new Error("ECONNRESET") : rpcOk({ amount: "5", locked: "0" })), calls),
  });
  assert.deepEqual(await rpc.viewAccount("alice.testnet"), { amount: "5", locked: "0" });
  assert.equal(calls.length, 2);

  const calls2: string[] = [];
  const rpc2 = new NearRpc({
    fetchFn: mockFetch(
      (url) => (url === TESTNET_RPC_URLS[0] ? { jsonrpc: "2.0", id: "x", error: { name: "INTERNAL_ERROR", cause: { name: "INTERNAL_ERROR" } } } : rpcOk({ amount: "7" })),
      calls2,
    ),
  });
  assert.equal((await rpc2.viewAccount("alice.testnet"))?.amount, "7");
  assert.equal(calls2.length, 2);

  const rpc3 = new NearRpc({ fetchFn: mockFetch(() => new Response("<html>bad gateway</html>", { status: 502 })) });
  await assert.rejects(rpc3.viewAccount("alice.testnet"), (e: unknown) => e instanceof NearRpcError && e.kind === "transport");
});

test("NearRpc: handler errors are definitive (no fallback); unknown key/account -> null", async () => {
  const calls: string[] = [];
  const rpc = new NearRpc({ fetchFn: mockFetch(() => handlerErr("UNKNOWN_ACCESS_KEY"), calls) });
  assert.equal(await rpc.viewAccessKey("alice.testnet", "ed25519:11111111111111111111111111111111"), null);
  assert.equal(calls.length, 1);

  const legacy = new NearRpc({ fetchFn: mockFetch(() => rpcOk({ error: "access key ed25519:x does not exist while viewing", logs: [], block_height: 1, block_hash: "h" })) });
  assert.equal(await legacy.viewAccessKey("alice.testnet", "ed25519:x"), null);

  const legacyJsonRpc = new NearRpc({ fetchFn: mockFetch(() => ({ jsonrpc: "2.0", id: "x", error: { code: -32000, message: "Server error", data: "UNKNOWN_ACCESS_KEY" } })) });
  assert.equal(await legacyJsonRpc.viewAccessKey("alice.testnet", "ed25519:x"), null);

  const noAccount = new NearRpc({ fetchFn: mockFetch(() => handlerErr("UNKNOWN_ACCOUNT")) });
  assert.equal(await noAccount.viewAccount("0".repeat(64)), null);

  const fc = new NearRpc({
    fetchFn: mockFetch(() => rpcOk({ permission: { FunctionCall: { allowance: null, receiver_id: CONTRACT, method_names: [] } }, nonce: 42, block_hash: "abc" })),
  });
  const key = await fc.viewAccessKey("alice.testnet", "ed25519:x");
  assert.equal(key?.permission.kind, "FunctionCall");
  assert.equal(key?.nonce, 42n);
});

test("NearRpc.txStatus: archival fallback only on UNKNOWN_TRANSACTION", async () => {
  const calls: string[] = [];
  const rpc = new NearRpc({
    fetchFn: mockFetch((url) => (url.includes("archival") ? rpcOk(FEED) : handlerErr("UNKNOWN_TRANSACTION")), calls),
  });
  const r = await rpc.txStatus("CTxwJMyp8RaHwCtw8uRoY581hhSm2HW75DLMdb7n4xL", CONTRACT);
  assert.equal(summarizeTxStatus(r)?.firstCall?.methodName, "feed_strain");
  assert.deepEqual(
    calls.map((c) => c.split(" ")[0]),
    [TESTNET_RPC_URLS[0], "https://archival-rpc.testnet.fastnear.com"],
  );

  const timeout = new NearRpc({ fetchFn: mockFetch(() => handlerErr("TIMEOUT_ERROR")) });
  await assert.rejects(timeout.txStatus("x", CONTRACT), (e: unknown) => e instanceof NearRpcError && e.causeName === "TIMEOUT_ERROR");
});

test("NearRpc.callView decodes JSON bytes; panics throw NearRpcError", async () => {
  const strain = { strain_id: 5, owner_id: "alice.testnet", status: "Active", effective_vitality: 7764 };
  const rpc = new NearRpc({ fetchFn: mockFetch(() => rpcOk({ result: [...Buffer.from(JSON.stringify(strain))], logs: [], block_height: 1, block_hash: "h" })) });
  assert.deepEqual(await rpc.callView(CONTRACT, "get_strain", { strain_id: 5 }), strain);
  const panic = new NearRpc({ fetchFn: mockFetch(() => rpcOk({ error: "wasm execution failed: strain not found", logs: [] })) });
  await assert.rejects(panic.callView(CONTRACT, "get_strain", { strain_id: 99 }), NearRpcError);
});

test("summarizeTxStatus: recorded feed_strain fixture", () => {
  const s = summarizeTxStatus(FEED);
  assert.ok(s);
  assert.equal(s.hash, "CTxwJMyp8RaHwCtw8uRoY581hhSm2HW75DLMdb7n4xL");
  assert.equal(s.signerId, CONTRACT);
  assert.equal(s.receiverId, CONTRACT);
  assert.equal(s.outcome, "success");
  assert.equal(s.blockHash, "3AF7tiGGLWCLrbeieoHCzugDhwAmAnTCHXd6hdjaja14");
  assert.equal(s.firstCall?.methodName, "feed_strain");
  assert.deepEqual(s.firstCall?.args, { strain_id: 5, amount: "100000000000000000000000" });
  assert.equal(extractStrainId(s.firstCall?.args), "5");
  assert.equal(strainIdFromReturn(s.successValue), "5"); // StrainVesselView in the SuccessValue
  assert.equal(checkTxForAccount(s, { accountId: CONTRACT, contractId: CONTRACT }), null);
  assert.equal(checkTxForAccount(s, { accountId: "alice.testnet", contractId: CONTRACT }), "tx_signer_mismatch");
  assert.equal(checkTxForAccount(s, { accountId: CONTRACT, contractId: "other.testnet" }), "tx_wrong_receiver");
});

test("summarizeTxStatus: recorded nft_transfer fixture (token_id string)", () => {
  const s = summarizeTxStatus(TRANSFER);
  assert.ok(s);
  assert.equal(s.firstCall?.methodName, "nft_transfer");
  assert.equal(s.firstCall?.deposit, "1");
  assert.equal(extractStrainId(s.firstCall?.args), "4");
  assert.equal(s.successValue, "");
});

test("summarizeTxStatus / checkTxForAccount: failure, pending, no FunctionCall, malformed", () => {
  const base = FEED as Record<string, unknown>;
  const failed = summarizeTxStatus({ ...base, status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: {} } } } } });
  assert.equal(failed?.outcome, "failure");
  assert.equal(checkTxForAccount(failed!, { accountId: CONTRACT, contractId: CONTRACT }), "tx_failed");
  const pending = summarizeTxStatus({ ...base, status: "Started" });
  assert.equal(checkTxForAccount(pending!, { accountId: CONTRACT, contractId: CONTRACT }), "tx_pending");
  const tx = base["transaction"] as Record<string, unknown>;
  const transferOnly = summarizeTxStatus({ ...base, transaction: { ...tx, actions: [{ Transfer: { deposit: "1" } }, "CreateAccount"] } });
  assert.equal(transferOnly?.firstCall, null);
  assert.equal(checkTxForAccount(transferOnly!, { accountId: CONTRACT, contractId: CONTRACT }), "tx_not_function_call");
  assert.equal(summarizeTxStatus(null), null);
  assert.equal(summarizeTxStatus({ transaction: {} }), null);
});

test("extractStrainId: priority, numeric strings, rejects junk and > i64", () => {
  assert.equal(extractStrainId({ target_id: 7, raider_strain_id: 8, expected_target_nonce: 1 }), "7");
  assert.equal(extractStrainId({ strain_id: 3, target_id: 9 }), "3");
  assert.equal(extractStrainId({ token_id: "12" }), "12");
  assert.equal(extractStrainId({ token_id: "abc" }), null);
  assert.equal(extractStrainId({ strain_id: -1 }), null);
  assert.equal(extractStrainId({ strain_id: "9223372036854775808" }), null);
  assert.equal(extractStrainId({ role: "Extractor" }), null);
  assert.equal(extractStrainId(null), null);
  assert.equal(extractStrainId([1]), null);
});

// ---- record-tx handler ----
function memRecordStore(accounts: Record<string, string>): RecordStore & { rows: ActivityRow[] } {
  const rows: ActivityRow[] = [];
  return {
    rows,
    async nearAccountIdOf(userId) {
      return accounts[userId] ?? null;
    },
    async achievementCodes(userId) {
      return [...computeAchievements(rows.filter((r) => r.user_id === userId).map((r) => ({ method: r.method, blockTimeMs: Date.parse(r.block_time) })))];
    },
    async insertActivity(row) {
      if (rows.some((r) => r.tx_hash === row.tx_hash)) return false;
      rows.push(row);
      return true;
    },
  };
}
const USER = "00000000-0000-4000-8000-000000000001";

test("record-tx: records the fixture tx, returns newly earned achievements once, idempotent", async () => {
  const store = memRecordStore({ [USER]: CONTRACT });
  const deps = { store, contractId: CONTRACT, txStatus: async () => FEED, blockTimestampMs: async () => Date.UTC(2026, 10, 9, 12) };
  const r = await handleRecordTx(USER, { txHash: "CTxwJMyp8RaHwCtw8uRoY581hhSm2HW75DLMdb7n4xL" }, deps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { recorded: true, method: "feed_strain", achievements: ["first_feed"] });
  assert.equal(store.rows[0]?.strain_id, "5");
  assert.equal(store.rows[0]?.block_time, "2026-11-09T12:00:00.000Z");
  const again = await handleRecordTx(USER, { txHash: "CTxwJMyp8RaHwCtw8uRoY581hhSm2HW75DLMdb7n4xL" }, deps);
  assert.deepEqual(again.body, { recorded: true, method: "feed_strain", achievements: [] });
  assert.equal(store.rows.length, 1);
});

test("record-tx: rejects bad hash, unknown profile, wrong signer, unknown tx, RPC outage", async () => {
  const store = memRecordStore({ [USER]: "alice.testnet" });
  const deps = (over: Partial<Parameters<typeof handleRecordTx>[2]> = {}) => ({
    store,
    contractId: CONTRACT,
    txStatus: async () => FEED,
    blockTimestampMs: async () => 0,
    ...over,
  });
  const err = (r: { body: unknown }) => (r.body as { error: string }).error;
  assert.equal(err(await handleRecordTx(USER, { txHash: "0OIl" }, deps())), "invalid_tx_hash");
  assert.equal(err(await handleRecordTx(USER, null, deps())), "bad_request");
  assert.equal(err(await handleRecordTx("nobody", { txHash: "CTxwJMyp8RaHwCtw8uRoY581hhSm2HW75DLMdb7n4xL" }, deps())), "no_profile");
  const wrongSigner = await handleRecordTx(USER, { txHash: "CTxwJMyp8RaHwCtw8uRoY581hhSm2HW75DLMdb7n4xL" }, deps());
  assert.equal(wrongSigner.status, 403);
  assert.equal(err(wrongSigner), "tx_signer_mismatch");
  const unknown = deps({ txStatus: async () => Promise.reject(new NearRpcError("rpc", "x", "HANDLER_ERROR", "UNKNOWN_TRANSACTION")) });
  assert.equal(err(await handleRecordTx(USER, { txHash: "CTxwJMyp8RaHwCtw8uRoY581hhSm2HW75DLMdb7n4xL" }, unknown)), "tx_not_found");
  const down = deps({ txStatus: async () => Promise.reject(new NearRpcError("transport", "down")) });
  assert.equal(err(await handleRecordTx(USER, { txHash: "CTxwJMyp8RaHwCtw8uRoY581hhSm2HW75DLMdb7n4xL" }, down)), "rpc_unavailable");
  assert.equal(store.rows.length, 0);
});
