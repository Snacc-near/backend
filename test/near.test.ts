import test from "node:test";
import assert from "node:assert/strict";
import { NearRpcClient, RpcError, isContractNotDeployed } from "../src/near.js";

function clientWith(body: unknown, status = 200): NearRpcClient {
  const fetchFn = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  return new NearRpcClient("http://rpc.test", fetchFn);
}

const VIEW_RESULT = {
  result: Array.from(Buffer.from(JSON.stringify({ crucible_temp: 900 }))),
  logs: [],
  block_height: 12345,
  block_hash: "AAA",
};

test("viewFunction decodes JSON result", async () => {
  const client = clientWith({ jsonrpc: "2.0", id: "x", result: VIEW_RESULT });
  const r = await client.viewFunction("c.near", "get_macro_state", "e30=");
  assert.equal(r.text, '{"crucible_temp":900}');
  assert.equal(r.block_height, 12345);
});

test("RpcError is thrown on JSON-RPC error", async () => {
  const client = clientWith({
    jsonrpc: "2.0",
    id: "x",
    error: { code: -32000, message: "Server error", data: "x" },
  });
  await assert.rejects(
    () => client.viewFunction("c.near", "get_macro_state", "e30="),
    RpcError,
  );
});

test("isContractNotDeployed recognizes UNKNOWN_ACCOUNT & ContractCodeNotFound", () => {
  const unknownAccount = new RpcError({
    code: -32000,
    message: "Server error",
    data: "account x.near does not exist while viewing",
  });
  const codeNotFound = new RpcError({
    code: -32000,
    message: "ContractCodeNotFound",
  });
  const other = new RpcError({ code: -32000, message: "gas limit exceeded" });
  assert.equal(isContractNotDeployed(unknownAccount), true);
  assert.equal(isContractNotDeployed(codeNotFound), true);
  assert.equal(isContractNotDeployed(other), false);
  assert.equal(isContractNotDeployed(new Error("plain")), false);
});
