import test from "node:test";
import assert from "node:assert/strict";
import {
  pollOnce,
  pollTick,
  absorbTxOutcome,
  newPollerState,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  type PollerRpc,
  type PollerState,
} from "../src/poller.js";
import { newEventStore, MAX_EVENTS, absorbEvent, type CrucibleEvent, type EventStore } from "../src/events.js";

const CONTRACT = "snacc-v001.testnet";

interface Fixture {
  rpc: PollerRpc;
  discovery: { calls: number; responses: Array<{ status: number; body?: unknown } | Error> };
  txOutcomes: Record<string, unknown>;
  blocks: Record<number, string[]>;
  blockCalls: number;
}

/** Stub sources: a discovery fetch + a NEAR RPC stub (`block`, `tx`) — no network. */
function fixture(
  discoveryResponses: Array<{ status: number; body?: unknown } | Error>,
  blocks: Record<number, string[]>,
  txOutcomes: Record<string, unknown> = {},
  opts: { failTxOn?: string[] } = {},
): Fixture {
  const f: Fixture = {
    rpc: null as unknown as PollerRpc,
    discovery: { calls: 0, responses: [...discoveryResponses] },
    txOutcomes,
    blocks,
    blockCalls: 0,
  };
  const headHeight = () => Math.max(0, ...Object.keys(blocks).map(Number));
  f.rpc = {
    async fetchJsonRpc<T>(method: string, params: unknown): Promise<T> {
      if (method === "block") {
        f.blockCalls++;
        const p = params as { finality?: string; block_id?: number };
        const height = p.finality === "final" ? headHeight() : p.block_id!;
        const chunks = blocks[height];
        if (chunks === undefined) throw new Error(`block ${height} not found`);
        return { header: { height }, chunks: chunks.map((id) => ({ chunk_hash: id })) } as T;
      }
      if (method === "tx") {
        const p = params as [string, string];
        if (opts.failTxOn?.includes(p[0])) throw new Error("HTTP 429 from RPC");
        const out = f.txOutcomes[p[0]];
        if (!out) throw new Error("tx not found");
        return out as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return f;
}

function discoveryFetchOf(fx: Fixture) {
  return async (url: string) => {
    fx.discovery.calls++;
    const next = fx.discovery.responses.shift();
    if (!next) return { ok: true, status: 200, json: async () => ({ data: [] }) };
    if (next instanceof Error) throw next;
    if (typeof next.body === "undefined") return { ok: false, status: next.status, json: async () => ({}) };
    return { ok: true, status: next.status, json: async () => next.body };
  };
}

const discoveryTx = (hash: string, height: number, tsNs: string, receiver = CONTRACT) => ({
  transaction_hash: hash,
  receiver_account_id: receiver,
  signer_account_id: "user.testnet",
  block_timestamp: tsNs,
  block: { block_height: String(height) },
});

const FED_EVENT = 'EVENT_JSON:{"standard":"snacc","version":"1.0.0","event":"fed","data":[{"kind":"fed","strain_id":1,"effective_fee":900,"atp_minted":2}]}';
const CALLBACK_EVENT = 'EVENT_JSON:{"standard":"snacc","version":"1.0.0","event":"subaccount_materialized","data":[{"kind":"subaccount_materialized","strain_id":1,"sub_account_id":"s-1-0.snacc-v001.testnet"}]}';

const txOutcome = (txLogs: string[], receiptLogs: string[][]) => ({
  transaction_outcome: { outcome: { logs: txLogs } },
  receipts_outcome: receiptLogs.map((logs, i) => ({ receipt_id: `rc-${i}`, outcome: { logs } })),
  transaction: { hash: "T1" },
});

test("backfill: the first discovery call fetches 50 and queues every new tx (budget 5/tick)", async () => {
  const data = Array.from({ length: 12 }, (_, i) =>
    discoveryTx(`T${i}`, 100 + i, String(1000 + i)),
  ).reverse(); // newest first
  const fx = fixture([], { 112: ["c"] },
    Object.fromEntries(data.map((t) => [t.transaction_hash, txOutcome([FED_EVENT], [])])),
  );
  const responses = [{ status: 200, body: { data } }, { status: 200, body: { data: [] } }, { status: 200, body: { data: [] } }];
  let requestedUrl = "";
  const fetchSpy = async (url: string) => {
    requestedUrl = url;
    fx.discovery.calls++;
    const next = responses.shift() ?? { status: 200, body: { data: [] } };
    return { ok: true, status: 200, json: async () => next.body };
  };
  const store = newEventStore();
  const state = newPollerState();

  await pollOnce(fx.rpc, fetchSpy, CONTRACT, store, state, 1000);
  assert.match(requestedUrl, /limit=50/); // backfill page size on the first tick
  assert.match(requestedUrl, /nearblocks\.io\/v3\/accounts\/snacc-v001\.testnet\/txns/);
  assert.equal(state.queue.length, 7); // 12 discovered − 5 absorbed (the budget)
  assert.equal(store.events.length, 5);
  assert.equal(state.processedTx, 5);
  assert.equal(state.caughtUp, false); // the queue is not drained yet → honest incomplete
  assert.equal(store.indexerComplete, false);
  assert.equal(state.cursorHeight, 104); // the 5 oldest absorbed (the queue drains oldest-first)
  assert.equal(state.lagBlocks, 8);
  assert.equal(state.rateLimitedErrors, 0);

  // Drain: 7 remaining → 5 + 2 → drained; the cursor reaches the newest.
  await pollOnce(fx.rpc, fetchSpy, CONTRACT, store, state, 2000);
  assert.equal(state.queue.length, 2);
  await pollOnce(fx.rpc, fetchSpy, CONTRACT, store, state, 3000);
  assert.equal(state.queue.length, 0);
  assert.equal(store.events.length, 12);
  assert.equal(state.cursorTimestampNs, "1011");
  assert.equal(state.cursorHeight, 111);
  assert.equal(state.caughtUp, true);
  assert.equal(store.indexerComplete, true);
  assert.equal(state.lagBlocks, 1);
});

test("the cursor skips already-discovered txs on later ticks (no duplicates, 1 discovery call/tick)", async () => {
  const data = [discoveryTx("T2", 105, "2005"), discoveryTx("T1", 104, "2004")];
  const fx = fixture(
    [
      { status: 200, body: { data } },
      { status: 200, body: { data } }, // the same list is returned again (the source is newest-first)
      { status: 200, body: { data } },
    ],
    { 105: ["c"] },
    {
      T1: txOutcome([FED_EVENT], []),
      T2: txOutcome([CALLBACK_EVENT], []),
    },
  );
  const fetch = discoveryFetchOf(fx);
  const store = newEventStore();
  const state = newPollerState();
  await pollOnce(fx.rpc, fetch, CONTRACT, store, state, 1000);
  assert.equal(store.events.length, 2);
  assert.equal(state.cursorTimestampNs, "2005");
  await pollOnce(fx.rpc, fetch, CONTRACT, store, state, 2000);
  await pollOnce(fx.rpc, fetch, CONTRACT, store, state, 3000);
  assert.equal(fx.discovery.calls, 3); // exactly 1 discovery call per tick
  assert.equal(store.events.length, 2); // no duplicates
  assert.equal(state.processedTx, 2);
  assert.equal(state.caughtUp, true);
});

test("a discovery 429 arms the global backoff: the next ticks make zero API calls", async () => {
  const fx = fixture(
    [{ status: 429 }, { status: 200, body: { data: [] } }],
    { 105: ["c"] },
  );
  const fetch = discoveryFetchOf(fx);
  const store = newEventStore();
  const state = newPollerState();
  await pollOnce(fx.rpc, fetch, CONTRACT, store, state, 1000);
  assert.equal(state.rateLimitedErrors, 1);
  assert.equal(state.backoffUntilMs, 1000 + BACKOFF_BASE_MS * 2);
  assert.equal(store.indexerComplete, false);
  assert.match(state.lastError ?? "", /discovery HTTP 429/);

  // Inside the backoff window: no API calls at all.
  const before = fx.discovery.calls + fx.blockCalls;
  await pollOnce(fx.rpc, fetch, CONTRACT, store, state, 1000 + BACKOFF_BASE_MS);
  assert.equal(fx.discovery.calls + fx.blockCalls, before); // zero calls while backing off
  assert.equal(state.backedOffTicks, 1);

  // After the backoff expires the poll resumes and the backoff counter resets on success.
  await pollOnce(fx.rpc, fetch, CONTRACT, store, state, 1000 + BACKOFF_BASE_MS * 2 + 1);
  assert.equal(state.rateLimitedErrors, 1);
  assert.equal(state.backoffAttempts, 0);
  assert.equal(state.caughtUp, true);
  assert.equal(store.indexerComplete, true);
});

test("a tx-level 429 re-queues the tx and keeps the cursor (no silent loss)", async () => {
  const fx = fixture(
    [{ status: 200, body: { data: [discoveryTx("T1", 104, "2004")] } }],
    { 104: ["c"] },
    {}, // T1 will fail
    { failTxOn: ["T1"] },
  );
  const fetch = discoveryFetchOf(fx);
  const store = newEventStore();
  const state = newPollerState();
  await pollOnce(fx.rpc, fetch, CONTRACT, store, state, 1000);
  assert.equal(state.rateLimitedErrors, 1);
  assert.match(state.lastError ?? "", /T1.*429/);
  assert.equal(state.queue.length, 1); // re-queued
  assert.equal(state.cursorTimestampNs, null); // not absorbed → cursor unchanged
  assert.equal(store.indexerComplete, false);

  // Next tick (after backoff): the same tx is retried and absorbed (a healthy RPC this time).
  fx.txOutcomes["T1"] = txOutcome([FED_EVENT], [[CALLBACK_EVENT]]);
  const healthy = fixture([], fx.blocks, fx.txOutcomes);
  const responses2 = [{ status: 200, body: { data: [] } }];
  const fetch2 = async (url: string) => {
    healthy.discovery.calls++;
    const next = responses2.shift() ?? { status: 200, body: { data: [] } };
    void url;
    return { ok: true, status: 200, json: async () => next.body };
  };
  await pollOnce(healthy.rpc, fetch2, CONTRACT, store, state, 1000 + BACKOFF_BASE_MS * 2 + 1);
  assert.equal(state.processedTx, 1);
  assert.deepEqual(store.events.map((e) => e.kind), ["fed", "subaccount_materialized"]);
  assert.equal(state.cursorHeight, 104);
  assert.equal(state.caughtUp, true);
});

test("backoff grows exponentially and is capped", async () => {
  const fx = fixture(
    Array.from({ length: 8 }, () => ({ status: 429 }) as { status: number }),
    { 105: ["c"] },
  );
  const fetch = discoveryFetchOf(fx);
  const store = newEventStore();
  const state = newPollerState();
  let now = 1000;
  for (let i = 1; i <= 6; i++) {
    await pollOnce(fx.rpc, fetch, CONTRACT, store, state, now);
    const expectedDelay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** i);
    assert.equal(state.backoffUntilMs, now + expectedDelay);
    now = state.backoffUntilMs + 1; // the next poll happens after the backoff expires
  }
  assert.equal(state.backoffAttempts, 6);
  assert.equal(state.rateLimitedErrors, 6);
});

test("a quiet contract: the lag stays fresh and the discovery is still 1 call/tick", async () => {
  const fx = fixture(
    [
      { status: 200, body: { data: [discoveryTx("T1", 100, "1000")] } },
      { status: 200, body: { data: [] } },
      { status: 200, body: { data: [] } },
    ],
    { 100: ["c"] },
    { T1: txOutcome([FED_EVENT], []) },
  );
  const fetch = discoveryFetchOf(fx);
  const store = newEventStore();
  const state = newPollerState();
  await pollOnce(fx.rpc, fetch, CONTRACT, store, state, 1000);
  assert.equal(state.lagBlocks, 0);
  fx.blocks[101] = ["c"];
  await pollOnce(fx.rpc, fetch, CONTRACT, store, state, 2000);
  fx.blocks[130] = ["c"]; // the chain advances 29 blocks with no contract txs
  await pollOnce(fx.rpc, fetch, CONTRACT, store, state, 3000);
  assert.equal(state.headHeight, 130);
  assert.equal(state.lagBlocks, 30); // honest: the newest known contract activity is 30 blocks behind the head
  assert.equal(state.caughtUp, true); // the discovery source is healthy — nothing new to fetch
  assert.equal(store.indexerComplete, true);
});

test("irrelevant accounts in the discovery feed are filtered out", async () => {
  const data = [
    discoveryTx("T-other", 105, "2005", "someone-else.testnet"),
    discoveryTx("T-ours", 104, "2004"),
  ];
  const fx = fixture([{ status: 200, body: { data } }], { 105: ["c"] }, {
    "T-ours": txOutcome([FED_EVENT], []),
  });
  const fetch = discoveryFetchOf(fx);
  const store = newEventStore();
  const state = newPollerState();
  await pollOnce(fx.rpc, fetch, CONTRACT, store, state, 1000);
  assert.equal(state.processedTx, 1);
  assert.equal(store.events.length, 1);
});

test("a hanging discovery ends as fail + backoff via the watchdog, not a hang", async () => {
  const fx = fixture([], { 104: ["c"] }, {});
  const store = newEventStore();
  const state = newPollerState();
  // A discovery fetch that never settles (like a socket that hangs forever).
  const hangingDiscovery = () => new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>(() => {});
  const t0 = Date.now();
  await assert.rejects(
    pollTick(fx.rpc, hangingDiscovery, CONTRACT, store, state, { nowMs: 1000, tickTimeoutMs: 50 }),
    /timed out/,
  );
  assert.ok(Date.now() - t0 < 5000, "the watchdog must cut the tick off quickly");
  assert.match(state.lastError ?? "", /timed out/);
  assert.equal(state.caughtUp, false);
  assert.equal(store.indexerComplete, false); // honest: incomplete
  assert.equal(state.backoffAttempts, 1);
  assert.equal(state.backoffUntilMs, 1000 + BACKOFF_BASE_MS * 2); // backoff armed
  // The timed-out pollOnce is still pending: a later tick (even past the backoff window)
  // must be skipped instead of overlapping it.
  let calls = 0;
  const countingDiscovery = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };
  await pollTick(fx.rpc, countingDiscovery, CONTRACT, store, state, { nowMs: 10_000_000, tickTimeoutMs: 50 });
  assert.equal(calls, 0, "no overlapping poll while the previous one is in flight");
  assert.equal(state.backedOffTicks, 1);
});

test("absorbTxOutcome does not re-absorb already-seen receipts", () => {
  const store = newEventStore();
  const state = newPollerState();
  const result = txOutcome([FED_EVENT], [[CALLBACK_EVENT]]);
  assert.equal(absorbTxOutcome(store, state, "T1", result, 5), 2);
  assert.equal(absorbTxOutcome(store, state, "T1", result, 5), 0);
  assert.equal(store.events.length, 2);
});

test("the in-memory store drops the oldest events beyond MAX_EVENTS", () => {
  const store: EventStore = newEventStore();
  for (let i = 0; i < MAX_EVENTS + 25; i++) {
    const ev: CrucibleEvent = { kind: "fed", block_height: i, raw: { kind: "fed", strain_id: 1 } };
    absorbEvent(store, ev);
  }
  assert.equal(store.events.length, MAX_EVENTS);
  assert.equal(store.droppedEvents, 25);
  assert.equal(store.events[0]!.block_height, 25); // the oldest 25 were evicted
  // strain_created tracking is unaffected by eviction
  const s: CrucibleEvent = { kind: "strain_created", raw: { kind: "strain_created", strain_id: 7, owner_id: "a.testnet" } };
  absorbEvent(store, s);
  assert.equal(store.strainsSeen.get(7)?.owner_id, "a.testnet");
});
