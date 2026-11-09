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

test("HTTP 429 is retried with backoff, then succeeds", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls <= 2) return new Response("rate limited", { status: 429 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result: VIEW_RESULT }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new NearRpcClient("http://rpc.test", fetchFn, 0); // retryDelayMs = 0 for tests
  const r = await client.viewFunction("c.near", "get_macro_state", "e30=");
  assert.equal(r.block_height, 12345);
  assert.equal(calls, 3);
});

test("a hanging RPC fetch is aborted by the per-request timeout (no stall)", async () => {
  let aborted = false;
  const fetchFn = ((_url: unknown, init?: { signal?: AbortSignal }) => {
    return new Promise<Response>((_, rej) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        rej(new Error("The operation was aborted"));
      });
    }) as unknown as Promise<Response>;
  }) as unknown as typeof fetch;
  const client = new NearRpcClient("http://rpc.test", fetchFn, 0, 50); // 50 ms timeout
  // AbortSignal.timeout uses an unref'd timer: keep the event loop alive (as the HTTP server
  // does in production), otherwise Node 22 ends the test before the signal fires.
  const keepAlive = setTimeout(() => {}, 5000);
  try {
    await assert.rejects(
      () => client.viewFunction("c.near", "get_macro_state", "e30="),
      /aborted/i,
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(aborted, true); // the timeout signal actually fired
});

test("persistent HTTP 429 exhausts the retries and throws RpcError", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return new Response("rate limited", { status: 429 });
  }) as unknown as typeof fetch;
  const client = new NearRpcClient("http://rpc.test", fetchFn, 0);
  await assert.rejects(
    () => client.viewFunction("c.near", "get_macro_state", "e30="),
    (err: unknown) => err instanceof RpcError && /429/.test(err.message),
  );
  assert.equal(calls, 4); // 1 initial + RETRY_ATTEMPTS (3)
});

// --- INT-rpc-fallback: pool rotation, Retry-After, cache, dedup, health ---

function okResponse(): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: "x", result: VIEW_RESULT }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const sleep = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));

test("rpc pool: 429 on the first endpoint rotates to the next and sticks to the healthy one", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: unknown) => {
    calls.push(String(url));
    if (String(url) === "http://a.test") return new Response("rate limited", { status: 429 });
    return okResponse();
  }) as unknown as typeof fetch;
  const client = new NearRpcClient(["http://a.test", "http://b.test"], fetchFn, 0, 0, {
    cooldownBaseMs: 60_000,
  });
  const r = await client.viewFunction("c.near", "get_macro_state", "e30=");
  assert.equal(r.block_height, 12345);
  assert.deepEqual(calls, ["http://a.test", "http://b.test"]);
  const status = client.rpcStatus();
  assert.equal(status.currentHost, "b.test");
  const a = status.endpoints.find((e) => e.host === "a.test")!;
  assert.equal(a.failures, 1);
  assert.ok(a.cooldownSeconds > 0, "a.test should be cooling down");
  // Second (uncached-args) request goes straight to the sticky healthy endpoint.
  await client.viewFunction("c.near", "get_macro_state", "e31=");
  assert.deepEqual(calls, ["http://a.test", "http://b.test", "http://b.test"]);
});

test("rpc pool: Retry-After is honoured over the exponential cooldown", async () => {
  const fetchFn = (async () =>
    new Response("rate limited", { status: 429, headers: { "Retry-After": "12" } })) as unknown as typeof fetch;
  // Base cooldown (50 ms) is far shorter than Retry-After (12 s): the 429 must still park it.
  const client = new NearRpcClient(["http://a.test"], fetchFn, 0, 0, { cooldownBaseMs: 50 });
  await assert.rejects(() => client.viewFunction("c.near", "m", "eA=="), RpcError);
  const status = client.rpcStatus();
  assert.equal(status.endpoints[0]!.failures, 4); // 1 initial + RETRY_ATTEMPTS
  assert.ok(status.endpoints[0]!.cooldownSeconds >= 11, "Retry-After 12 s should dominate");
});

test("view cache: fresh TTL hit avoids a second fetch; expiry fetches again", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    return okResponse();
  }) as unknown as typeof fetch;
  const client = new NearRpcClient(["http://a.test"], fetchFn, 0, 0, { viewCacheTtlMs: 30 });
  await client.viewFunction("c.near", "get_macro_state", "e30=");
  await client.viewFunction("c.near", "get_macro_state", "e30="); // fresh hit
  assert.equal(calls, 1);
  await sleep(50); // let TTL expire
  await client.viewFunction("c.near", "get_macro_state", "e30=");
  assert.equal(calls, 2);
  const c = client.rpcStatus().cache;
  assert.equal(c.hits, 1);
  assert.equal(c.misses, 2);
});

test("view cache: in-flight de-dup — concurrent identical calls share one RPC request", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((ok) => {
    release = ok;
  });
  const fetchFn = (async () => {
    calls++;
    await gate;
    return okResponse();
  }) as unknown as typeof fetch;
  const client = new NearRpcClient(["http://a.test"], fetchFn, 0, 0);
  const p1 = client.viewFunction("c.near", "get_macro_state", "e30=");
  const p2 = client.viewFunction("c.near", "get_macro_state", "e30=");
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.block_height, 12345);
  assert.equal(r2.block_height, 12345);
  assert.equal(calls, 1);
});

test("view cache: stale-if-error serves the cached view labelled; errors are never cached", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) return okResponse();
    return new Response("rate limited", { status: 429 });
  }) as unknown as typeof fetch;
  const client = new NearRpcClient(["http://a.test"], fetchFn, 0, 0, {
    viewCacheTtlMs: 30,
    viewStaleTtlMs: 60_000,
    cooldownBaseMs: 1,
  });
  await client.viewFunction("c.near", "get_macro_state", "e30=");
  await sleep(50); // past fresh TTL, inside the stale window; RPC now fails
  const stale = await client.viewFunction("c.near", "get_macro_state", "e30=");
  assert.equal(stale.text, '{"crucible_temp":900}');
  assert.ok((stale.staleSeconds ?? 0) >= 1, "stale serve must be labelled with its age");
  assert.equal(client.rpcStatus().cache.staleServed, 1);
  // Errors were not cached as data: with an empty cache the same failure throws.
  await assert.rejects(() => client.viewFunction("c.near", "get_macro_state", "e31="), RpcError);
});

test("view cache: stale is NOT served past the stale window", async () => {
  let calls = 0;
  const fetchFn = (async () => {
    calls++;
    if (calls === 1) return okResponse();
    return new Response("rate limited", { status: 429 });
  }) as unknown as typeof fetch;
  const client = new NearRpcClient(["http://a.test"], fetchFn, 0, 0, {
    viewCacheTtlMs: 10,
    viewStaleTtlMs: 20,
    cooldownBaseMs: 1,
  });
  await client.viewFunction("c.near", "get_macro_state", "e30=");
  await sleep(40); // past both windows (10 ms fresh, 20 ms stale)
  await assert.rejects(() => client.viewFunction("c.near", "get_macro_state", "e30="), RpcError);
});
