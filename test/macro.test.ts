import test from "node:test";
import assert from "node:assert/strict";
import { NearRpcClient, RpcError } from "../src/near.js";
import { fetchMacroState, fetchStrain, zoneOf } from "../src/macro.js";

const MACRO_STATE = {
  current_epoch: 0,
  last_update_ms: 1730976000000,
  volume_epoch: "9000",
  total_snacc_supply: "1000000",
  total_snacc_burned: "0",
  epoch_treasury_spent: "0",
  epoch_treasury_initial: "200000",
  nutrient_burst_bps: 0,
  nutrient_burst_until: 0,
  industrial_dividend_pool: "0",
  epoch_dividend_inflow: "0",
  epoch_aether_burned_total: "0",
  last_closed_epoch: 0,
  crucible_temp: 1120,
};

function clientWithResult(result: unknown, logs: string[] = []): NearRpcClient {
  const body = {
    jsonrpc: "2.0",
    id: "x",
    result: {
      result: Array.from(Buffer.from(JSON.stringify(result))),
      logs,
      block_height: 777,
      block_hash: "AAA",
    },
  };
  const fetchFn = (async () =>
    new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  return new NearRpcClient("http://rpc.test", fetchFn);
}

function clientWithRpcError(data: string): NearRpcClient {
  const body = {
    jsonrpc: "2.0",
    id: "x",
    error: { code: -32000, message: "Server error", data },
  };
  const fetchFn = (async () =>
    new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  return new NearRpcClient("http://rpc.test", fetchFn);
}

test("zoneOf: batas 600/610 (ECON-111 supersede 1400)", () => {
  assert.equal(zoneOf(599), "Hypothermia");
  assert.equal(zoneOf(600), "Goldilocks");
  assert.equal(zoneOf(610), "Goldilocks");
  assert.equal(zoneOf(611), "Fever");
});

test("fetchMacroState memetakan field sesuai spec", async () => {
  const m = await fetchMacroState(clientWithResult(MACRO_STATE), "snacc-v001.testnet");
  assert.ok(!("error" in m));
  assert.equal(m.zone, "Fever"); // 1120 mK > 610 (threshold ECON-111) = Fever
  assert.equal(m.crucibleTemp, 1120);
  assert.equal(m.totalVitaSupply, "1000000");
  assert.equal(m.ruleBoundTreasury, "200000");
  assert.equal(m.blockHeight, 777);
});

test("fetchMacroState -> contract_not_deployed saat akun tidak ada", async () => {
  const m = await fetchMacroState(
    clientWithRpcError("account snacc-v001.testnet does not exist while viewing"),
    "snacc-v001.testnet",
  );
  assert.deepEqual(m, { error: "contract_not_deployed" });
});

test("fetchStrain mengembalikan view utuh", async () => {
  const strain = { strain_id: 1, owner_id: "a.testnet", effective_vitality: 8500 };
  const s = await fetchStrain(clientWithResult(strain), "snacc-v001.testnet", 1);
  assert.ok(!("error" in s));
  assert.equal(s.strain_id, 1);
  assert.equal(s.effective_vitality, 8500);
});

test("fetchStrain -> strain_not_found untuk null", async () => {
  const s = await fetchStrain(clientWithResult(null), "snacc-v001.testnet", 99);
  assert.deepEqual(s, { error: "strain_not_found" });
});

test("fetchStrain -> contract_not_deployed", async () => {
  const s = await fetchStrain(
    clientWithRpcError("ContractCodeNotFound"),
    "snacc-v001.testnet",
    1,
  );
  assert.deepEqual(s, { error: "contract_not_deployed" });
});

test("error RPC lain tetap dilempar (bukan ditelan)", async () => {
  await assert.rejects(
    () => fetchMacroState(clientWithRpcError("gas limit exceeded"), "c.near"),
    RpcError,
  );
});
