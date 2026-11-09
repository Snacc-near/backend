import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { route, newStore } from "../src/server.js";
import { NearRpcClient, quoteU128Fields } from "../src/near.js";
import { absorbEvent } from "../src/events.js";
import { clearAttestationCache } from "../src/tee.js";

function fakeReq(path: string): IncomingMessage {
  return { url: path } as unknown as IncomingMessage;
}

type Handler = (args: Record<string, unknown>) => string | { panic: string };

/** Fake RPC per contract method. `string` = raw JSON text (may contain unquoted u128). */
function rpcByMethod(handlers: Record<string, Handler>): NearRpcClient {
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { params: { method_name: string; args_base64: string } };
    const h = handlers[req.params.method_name];
    if (!h) throw new Error(`unstubbed method: ${req.params.method_name}`);
    const args = JSON.parse(Buffer.from(req.params.args_base64, "base64").toString("utf8")) as Record<string, unknown>;
    const out = h(args);
    const result =
      typeof out === "string"
        ? { result: Array.from(Buffer.from(out)), logs: [], block_height: 555, block_hash: "H" }
        : { error: out.panic, logs: [], block_height: 555, block_hash: "H" };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }), { status: 200 });
  }) as unknown as typeof fetch;
  return new NearRpcClient("http://rpc.test", fetchFn);
}

function deps(rpc: NearRpcClient, extra: Record<string, unknown> = {}) {
  return { rpc, contractId: "snacc-v001.testnet", store: newStore(), ...extra };
}

const strainJson = (id: number, status = "Active") =>
  `{"strain_id":${id},"owner_id":"a.testnet","vault_subaccount":"s-${id}.snacc-v001.testnet","vitality":8500,"atp_balance":575782630123456789012345,"status":"${status}","effective_vitality":8400}`;

test("quoteU128Fields: unquoted u128 becomes exact string, not float", () => {
  const raw = '{"atp_balance":575782630123456789012345,"other":12}';
  const parsed = JSON.parse(quoteU128Fields(raw, ["atp_balance"])) as { atp_balance: string; other: number };
  assert.equal(parsed.atp_balance, "575782630123456789012345");
  assert.equal(parsed.other, 12);
  // already quoted -> not double-quoted
  assert.equal(quoteU128Fields('{"atp_balance":"5"}', ["atp_balance"]), '{"atp_balance":"5"}');
});

test("/api/strains: enumerate nft_total_supply + get_strain, count statuses", async () => {
  const rpc = rpcByMethod({
    nft_total_supply: () => '"3"',
    get_strain: (a) => strainJson(a["strain_id"] as number, a["strain_id"] === 2 ? "Distressed" : a["strain_id"] === 3 ? "SplicedBurned" : "Active"),
  });
  const res = await route(fakeReq("/api/strains"), deps(rpc));
  assert.equal(res.status, 200);
  const b = res.body as { strains: Array<{ strain_id: number; atp_balance: string }>; starvingCount: number; splicedCount: number; totalMinted: number; truncated: boolean; indexer_incomplete: boolean };
  assert.deepEqual(b.strains.map((s) => s.strain_id), [1, 2, 3]);
  assert.equal(b.strains[0]?.atp_balance, "575782630123456789012345");
  assert.equal(b.starvingCount, 1);
  assert.equal(b.splicedCount, 1);
  assert.equal(b.totalMinted, 3);
  assert.equal(b.truncated, false);
  assert.equal(b.indexer_incomplete, false);
  // spec alias
  const alias = await route(fakeReq("/api/crucible/strains"), deps(rpc));
  assert.equal(alias.status, 200);
});

test("/api/strains: 0 strains -> honest empty list", async () => {
  const rpc = rpcByMethod({ nft_total_supply: () => '"0"' });
  const res = await route(fakeReq("/api/strains"), deps(rpc));
  assert.equal(res.status, 200);
  assert.deepEqual((res.body as { strains: unknown[] }).strains, []);
});

test("/api/strains/:id: view panic -> 404 strain_not_found (not 500)", async () => {
  const rpc = rpcByMethod({ get_strain: () => ({ panic: "wasm execution failed with error: WasmTrap(Unreachable)" }) });
  const res = await route(fakeReq("/api/strains/99"), deps(rpc));
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "strain_not_found" });
});

test("/api/strains/:id/svg: decode nft_token data URI -> image/svg+xml", async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"></svg>';
  const rpc = rpcByMethod({
    nft_token: (a) => {
      assert.equal(a["token_id"], "5");
      return JSON.stringify({
        token_id: "5",
        owner_id: "a.testnet",
        metadata: { title: "t", description: "d", media: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` },
      });
    },
  });
  const res = await route(fakeReq("/api/strains/5/svg"), deps(rpc));
  assert.equal(res.status, 200);
  assert.match(res.contentType ?? "", /^image\/svg\+xml/);
  assert.equal(res.body, svg);
  assert.ok(res.headers?.["Content-Security-Policy"]);
  const alias = await route(fakeReq("/api/crucible/strains/5/svg"), deps(rpc));
  assert.equal(alias.status, 200);
});

test("/api/strains/:id/svg: missing token -> 404; non-SVG media -> 502", async () => {
  const missing = await route(
    fakeReq("/api/strains/9/svg"),
    deps(rpcByMethod({ nft_token: () => ({ panic: "ERR_STRAIN_NOT_FOUND" }) })),
  );
  assert.equal(missing.status, 404);
  const odd = await route(
    fakeReq("/api/strains/9/svg"),
    deps(rpcByMethod({ nft_token: () => '{"token_id":"9","owner_id":"a.testnet","metadata":{"media":"https://x/y.png"}}' })),
  );
  assert.equal(odd.status, 502);
  assert.deepEqual(odd.body, { error: "svg_media_unavailable" });
});

test("/api/colony/:owner: get_colony + get_colony_atp; invalid account id -> 400", async () => {
  const rpc = rpcByMethod({
    get_colony: (a) => {
      assert.equal(a["owner_id"], "alkemis.testnet");
      return `[${strainJson(5)}]`;
    },
    get_colony_atp: () => '"575782630123456789012345"',
  });
  const res = await route(fakeReq("/api/colony/alkemis.testnet"), deps(rpc));
  assert.equal(res.status, 200);
  const b = res.body as { owner_id: string; strains: Array<{ atp_balance: string }>; colonyAtp: string; blockHeight: number };
  assert.equal(b.owner_id, "alkemis.testnet");
  assert.equal(b.strains.length, 1);
  assert.equal(b.colonyAtp, "575782630123456789012345");
  assert.equal(b.blockHeight, 555);
  for (const bad of ["/api/colony/A..b", "/api/colony/%E0%A4%A", "/api/colony/x"]) {
    const r = await route(fakeReq(bad), deps(rpc));
    assert.equal(r.status, 400, bad);
  }
});

test("/api/dividends: pool + epoch rates + optional contribution", async () => {
  const asked: number[] = [];
  const rpc = rpcByMethod({
    get_dividend_pool: () => '["64000000000000","353714000000000000000000",2]',
    get_epoch_dividend_rate: (a) => {
      asked.push(a["epoch"] as number);
      return `"${(a["epoch"] as number) * 1000}"`;
    },
    get_dividend_contribution: (a) => {
      assert.deepEqual(a, { epoch: 2, strain_id: 7 });
      return '["12345",true]';
    },
  });
  const res = await route(fakeReq("/api/dividends?epoch=2&strain_id=7"), deps(rpc));
  assert.equal(res.status, 200);
  const b = res.body as {
    industrial_dividend_pool: string;
    epoch_dividend_inflow: string;
    last_closed_epoch: number;
    epoch_dividend_rate: Array<{ epoch: number; rate: string }>;
    contribution: { amount: string; claimed: boolean };
  };
  assert.equal(b.industrial_dividend_pool, "64000000000000");
  assert.equal(b.epoch_dividend_inflow, "353714000000000000000000");
  assert.equal(b.last_closed_epoch, 2);
  assert.deepEqual(b.epoch_dividend_rate, [
    { epoch: 1, rate: "1000" },
    { epoch: 2, rate: "2000" },
  ]);
  assert.deepEqual(b.contribution, { epoch: 2, strain_id: 7, amount: "12345", claimed: true });

  const half = await route(fakeReq("/api/dividends?epoch=2"), deps(rpc));
  assert.equal(half.status, 400);
});

test("/api/appetite: get_appetite_meter + top feeder, exact u128 strings", async () => {
  const rpc = rpcByMethod({
    get_appetite_meter: () =>
      '{"zone":"FEVER","crucible_temp":673,"current_epoch":2,"burst_bps":0,"burst_until":0,"burst_epochs_left":0,"dormant":false,"feast_volume":422128000000000000000000,"feast_target":79264999950000000000000,"risk_heat":10000}',
    get_top_feeder: (a) => {
      assert.equal(a["epoch"], 2);
      return '[{"account_id":"a.testnet","amount":422128000000000000000000}]';
    },
  });
  const res = await route(fakeReq("/api/appetite"), deps(rpc));
  assert.equal(res.status, 200);
  const b = res.body as { zone: string; feast_volume: string; feast_target: string; risk_heat: number; top_feeders: Array<{ amount: string }> };
  assert.equal(b.zone, "FEVER");
  assert.equal(b.feast_volume, "422128000000000000000000");
  assert.equal(b.feast_target, "79264999950000000000000");
  assert.equal(b.risk_heat, 10000);
  assert.equal(b.top_feeders[0]?.amount, "422128000000000000000000");
});

test("/api/zones: current zone from view + history from event store (marked incomplete)", async () => {
  const rpc = rpcByMethod({
    get_appetite_meter: () => '{"zone":"FEVER","crucible_temp":673,"current_epoch":2,"feast_volume":1,"feast_target":2}',
    get_macro_state: () =>
      '{"last_zone":"Fever","params":{"fever_threshold_mk":610,"hypothermia_threshold_mk":600}}',
  });
  const d = deps(rpc);
  absorbEvent(d.store, { kind: "zone_changed", raw: { kind: "zone_changed", from_zone: "NORMAL", to_zone: "FEVER", crucible_temp: 650 } });
  absorbEvent(d.store, { kind: "strain_created", raw: { kind: "strain_created", strain_id: 1, owner_id: "a" } });
  const res = await route(fakeReq("/api/zones"), d);
  assert.equal(res.status, 200);
  const b = res.body as { current: { zone: string; fever_threshold_mk: number; hypothermia_threshold_mk: number; last_zone: string }; history: unknown[]; history_complete: boolean; indexer_incomplete: boolean };
  assert.equal(b.current.zone, "FEVER");
  assert.equal(b.current.last_zone, "Fever");
  assert.equal(b.current.fever_threshold_mk, 610);
  assert.equal(b.current.hypothermia_threshold_mk, 600);
  assert.equal(b.history.length, 1);
  assert.equal(b.history_complete, false);
  assert.equal(b.indexer_incomplete, true);
});

test("/api/zones: history entries carry block_height/receipt_id + exact contract fields (EN-106)", async () => {
  const rpc = rpcByMethod({
    get_appetite_meter: () => '{"zone":"FEVER","crucible_temp":673,"current_epoch":2,"feast_volume":1,"feast_target":2}',
    get_macro_state: () =>
      '{"last_zone":"Fever","params":{"fever_threshold_mk":610,"hypothermia_threshold_mk":600}}',
  });
  const d = deps(rpc);
  // Absorb out of order: response must be ascending by block height.
  absorbEvent(d.store, { kind: "zone_changed", block_height: 300, receipt_id: "r2", raw: { kind: "zone_changed", from_zone: "NORMAL", to_zone: "FEVER", crucible_temp: 1500 } });
  absorbEvent(d.store, { kind: "zone_changed", block_height: 100, receipt_id: "r1", raw: { kind: "zone_changed", from_zone: "HYPOTHERMIA", to_zone: "NORMAL", crucible_temp: 650 } });
  absorbEvent(d.store, { kind: "strain_created", raw: { kind: "strain_created", strain_id: 9 } });
  d.store.indexerComplete = true;
  const res = await route(fakeReq("/api/zones"), d);
  assert.equal(res.status, 200);
  const b = res.body as { history: Array<{ kind: string; block_height: number | null; receipt_id: string | null; from_zone: string | null; to_zone: string | null; crucible_temp: number | null }>; history_complete: boolean; indexer_incomplete: boolean; current: { zone: string } };
  assert.equal(b.current.zone, "FEVER");
  assert.deepEqual(b.history, [
    { kind: "zone_changed", block_height: 100, receipt_id: "r1", from_zone: "HYPOTHERMIA", to_zone: "NORMAL", crucible_temp: 650 },
    { kind: "zone_changed", block_height: 300, receipt_id: "r2", from_zone: "NORMAL", to_zone: "FEVER", crucible_temp: 1500 },
  ]);
  assert.equal(b.history_complete, true);
  assert.equal(b.indexer_incomplete, false);
});

test("/api/zones: no fabrication — missing poller metadata stays null; empty store is honest", async () => {
  const rpc = rpcByMethod({
    get_appetite_meter: () => '{"zone":"NORMAL","crucible_temp":900,"current_epoch":0,"feast_volume":0,"feast_target":1}',
    get_macro_state: () =>
      '{"last_zone":"Normal","params":{"fever_threshold_mk":1400,"hypothermia_threshold_mk":600}}',
  });
  const d = deps(rpc);
  absorbEvent(d.store, { kind: "zone_changed", raw: { kind: "zone_changed" } });
  const res = await route(fakeReq("/api/zones"), d);
  assert.equal(res.status, 200);
  const b = res.body as { history: Array<{ block_height: null; receipt_id: null; from_zone: null; to_zone: null; crucible_temp: null }>; indexer_incomplete: boolean };
  assert.deepEqual(b.history, [{ kind: "zone_changed", block_height: null, receipt_id: null, from_zone: null, to_zone: null, crucible_temp: null }]);
  assert.equal(b.indexer_incomplete, true);

  const empty = await route(fakeReq("/api/zones"), deps(rpc));
  assert.equal(empty.status, 200);
  const e = empty.body as { history: unknown[]; indexer_incomplete: boolean; history_complete: boolean };
  assert.deepEqual(e.history, []);
  assert.equal(e.indexer_incomplete, true);
  assert.equal(e.history_complete, false);
});

test("view routes -> 503 contract_not_deployed when contract account is missing", async () => {
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({ jsonrpc: "2.0", id: "x", error: { code: -32000, message: "Server error", data: "account c.testnet does not exist while viewing" } }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const rpc = new NearRpcClient("http://rpc.test", fetchFn);
  for (const p of ["/api/strains", "/api/strains/1/svg", "/api/colony/a.testnet", "/api/dividends", "/api/appetite", "/api/zones"]) {
    const res = await route(fakeReq(p), deps(rpc));
    assert.equal(res.status, 503, p);
    assert.deepEqual(res.body, { error: "contract_not_deployed" }, p);
  }
});

test("RPC 429 is retried then succeeds; persistent 429 -> 503 rpc_unavailable (not 500)", async () => {
  let n = 0;
  const flaky = (async () => {
    n++;
    if (n < 3) return new Response("slow down", { status: 429 });
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: "x", result: { result: Array.from(Buffer.from('"7"')), logs: [], block_height: 1, block_hash: "H" } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const r = await new NearRpcClient("http://rpc.test", flaky, 0).viewFunction("c.near", "nft_total_supply", "e30=");
  assert.equal(r.text, '"7"');
  assert.equal(n, 3, "2x 429 then success");

  const always429 = (async () => new Response("x", { status: 429 })) as unknown as typeof fetch;
  const res = await route(fakeReq("/api/zones"), deps(new NearRpcClient("http://rpc.test", always429, 0)));
  assert.equal(res.status, 503);
  assert.equal((res.body as { error: string }).error, "rpc_unavailable");
});

test("/api/tee/attestation-report: maps to spec shape + caches + handles upstream errors", async () => {
  clearAttestationCache();
  let calls = 0;
  const upstream = {
    gateway_attestation: { signing_address: "40599fb2", signing_algo: "ed25519", intel_quote: "04" },
    model_attestations: [{ model_name: "z-ai/glm-5.3-flash" }],
  };
  const fetchFn = (async (url: string) => {
    calls++;
    assert.match(url, /cloud-api\.near\.ai\/v1\/attestation\/report\?model=z-ai%2Fglm-5\.3-flash&signing_algo=ed25519/);
    return new Response(JSON.stringify(upstream), { status: 200 });
  }) as unknown as typeof fetch;
  const d = deps(rpcByMethod({}), { fetchFn });
  const res = await route(fakeReq("/api/tee/attestation-report"), d);
  assert.equal(res.status, 200);
  const b = res.body as { model: string; signingAddress: string; gatewayAttestation: unknown; modelAttestations: unknown[] };
  assert.equal(b.model, "z-ai/glm-5.3-flash");
  assert.equal(b.signingAddress, "40599fb2");
  assert.deepEqual(b.gatewayAttestation, upstream.gateway_attestation);
  assert.deepEqual(b.modelAttestations, upstream.model_attestations);
  await route(fakeReq("/api/tee/attestation-report"), d);
  assert.equal(calls, 1, "second call served from cache");

  clearAttestationCache();
  const down = await route(fakeReq("/api/tee/attestation-report"), deps(rpcByMethod({}), {
    fetchFn: (async () => new Response("x", { status: 503 })) as unknown as typeof fetch,
  }));
  assert.equal(down.status, 502);
  assert.equal((down.body as { error: string }).error, "tee_upstream_unavailable");

  clearAttestationCache();
  const bad = await route(fakeReq("/api/tee/attestation-report"), deps(rpcByMethod({}), {
    fetchFn: (async () => new Response('{"x":1}', { status: 200 })) as unknown as typeof fetch,
  }));
  assert.equal(bad.status, 502);
  assert.equal((bad.body as { error: string }).error, "tee_upstream_malformed");
  clearAttestationCache();
});
