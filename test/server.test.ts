import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { route, newStore } from "../src/server.js";
import { newPollerState } from "../src/poller.js";
import { NearRpcClient } from "../src/near.js";
import type { IncomingMessage } from "node:http";

function fakeReq(path: string): IncomingMessage {
  return { url: path } as unknown as IncomingMessage;
}

function clientWithResult(result: unknown): NearRpcClient {
  const body = {
    jsonrpc: "2.0",
    id: "x",
    result: {
      result: Array.from(Buffer.from(JSON.stringify(result))),
      logs: [],
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

test("route: /api/crucible/macro 200 from stubbed RPC", async () => {
  const res = await route(fakeReq("/api/crucible/macro"), {
    rpc: clientWithResult({ crucible_temp: 1500, total_snacc_supply: "1000000" }),
    contractId: "snacc-v001.testnet",
    store: newStore(),
  });
  assert.equal(res.status, 200);
  assert.equal((res.body as { zone: string }).zone, "Fever");
});

test("route: macro 503 when contract is not deployed", async () => {
  const res = await route(fakeReq("/api/crucible/macro"), {
    rpc: clientWithRpcError("account snacc-v001.testnet does not exist while viewing"),
    contractId: "snacc-v001.testnet",
    store: newStore(),
  });
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: "contract_not_deployed" });
});

test("route: /api/strains empty when NFT supply is 0 (from view, not event store)", async () => {
  const res = await route(fakeReq("/api/strains"), {
    rpc: clientWithResult("0"),
    contractId: "c.near",
    store: newStore(),
  });
  assert.equal(res.status, 200);
  const body = res.body as { strains: unknown[]; indexer_incomplete: boolean; source: string };
  assert.deepEqual(body.strains, []);
  assert.equal(body.indexer_incomplete, false);
  assert.equal(body.source, "view:nft_total_supply+get_strain");
});

test("route: /api/events still flags indexer_incomplete", async () => {
  const res = await route(fakeReq("/api/events"), {
    rpc: clientWithResult({}),
    contractId: "c.near",
    store: newStore(),
  });
  assert.equal(res.status, 200);
  assert.equal((res.body as { indexer_incomplete: boolean }).indexer_incomplete, true);
  assert.equal(res.headers?.["x-indexer-lag-blocks"], undefined); // no poller state -> no lag header
});

test("route: /api/events exposes the measured lag as a response header (not a body field)", async () => {
  const store = newStore();
  store.indexerComplete = true;
  const res = await route(fakeReq("/api/events"), {
    rpc: clientWithResult({}),
    contractId: "c.near",
    store,
    poller: { ...newPollerState(), cursorHeight: 90, headHeight: 97, lagBlocks: 7, caughtUp: false },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers?.["x-indexer-lag-blocks"], "7");
  assert.equal((res.body as { indexer_incomplete: boolean }).indexer_incomplete, false);
  // A cursor that has reached the head reports lag 0.
  const res2 = await route(fakeReq("/api/events"), {
    rpc: clientWithResult({}),
    contractId: "c.near",
    store,
    poller: { ...newPollerState(), cursorHeight: 97, headHeight: 97, lagBlocks: 0, caughtUp: true },
  });
  assert.equal(res2.headers?.["x-indexer-lag-blocks"], "0");
});

test("route: /api/strains/:id 404 strain_not_found", async () => {
  const res = await route(fakeReq("/api/strains/99"), {
    rpc: clientWithResult(null),
    contractId: "c.near",
    store: newStore(),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(res.body, { error: "strain_not_found" });
});

test("route: evaluate-genome is no longer a 501 stub (VC-015): GET -> 405, POST without key -> 503", async () => {
  const deps = { rpc: clientWithResult({}), contractId: "c.near", store: newStore() };
  const get = await route({ url: "/api/tee/evaluate-genome", method: "GET" } as unknown as IncomingMessage, deps);
  assert.equal(get.status, 405);
  const post = await route({ url: "/api/tee/evaluate-genome", method: "POST" } as unknown as IncomingMessage, deps);
  assert.deepEqual([post.status, post.body], [503, { error: "tee_not_configured" }]);
});

test("route: unknown path -> 404", async () => {
  const res = await route(fakeReq("/api/unknown"), {
    rpc: clientWithResult({}),
    contractId: "c.near",
    store: newStore(),
  });
  assert.equal(res.status, 404);
});

test("end-to-end HTTP server on port 0", async () => {
  const { createServer: createHttp } = await import("node:http");
  const srv = createHttp((req, res) => {
    void route(req, {
      rpc: clientWithRpcError("account c.testnet does not exist while viewing"),
      contractId: "c.testnet",
      store: newStore(),
    }).then((r) => {
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const port = (srv.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/crucible/macro`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "contract_not_deployed" });
  srv.close();
});
