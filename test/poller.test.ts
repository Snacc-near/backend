import test from "node:test";
import assert from "node:assert/strict";
import {
  pollOnce,
  absorbTxOutcome,
  newPollerState,
  indexerLagBlocks,
  MAX_BLOCKS_PER_TICK,
  type PollerRpc,
  type PollerState,
} from "../src/poller.js";
import { newEventStore, MAX_EVENTS, absorbEvent, type CrucibleEvent, type EventStore } from "../src/events.js";
import { RpcError } from "../src/near.js";

interface Fixture {
  client: PollerRpc;
  blocks: Record<number, string[]>; // height -> chunk ids (mutate to advance the chain)
  chunks: Record<
    string,
    {
      receipts?: Array<{ receipt_id: string; outcome: { logs: string[] } }>;
      transactions?: Array<{ hash: string; receiver_id: string; signer_id: string }>;
    }
  >;
  txOutcomes: Record<string, unknown>; // tx hash -> `tx` result
  calls: string[];
}

/** Stub client that answers `block`/`chunk`/`tx` from fixtures — no network. */
function fixtureClient(
  blocks: Record<number, string[]>,
  chunks: Fixture["chunks"],
  txOutcomes: Record<string, unknown> = {},
  opts: { failOn?: string; rpcError?: { code: number; message: string } } = {},
): Fixture {
  const calls: string[] = [];
  const head = () => Math.max(...Object.keys(blocks).map(Number));
  const client: PollerRpc = {
    async fetchJsonRpc<T>(method: string, params: unknown): Promise<T> {
      calls.push(`${method}:${JSON.stringify(params)}`);
      if (opts.failOn && method === opts.failOn) {
        throw new RpcError(opts.rpcError ?? { code: -32000, message: "HTTP 429 from RPC" });
      }
      if (method === "block") {
        const p = params as { finality?: string; block_id?: number };
        const height = p.finality === "final" ? head() : p.block_id!;
        const chunk_ids = blocks[height];
        if (!chunk_ids) throw new RpcError({ code: -32000, message: `block ${height} not found` });
        // The real RPC block result: header.height + chunks[] with chunk_hash per shard.
        return { header: { height }, chunks: chunk_ids.map((id) => ({ chunk_hash: id })) } as T;
      }
      if (method === "chunk") {
        const p = params as { chunk_id: string };
        return { header: { height: 0, chunk_hash: p.chunk_id }, ...chunks[p.chunk_id] } as T;
      }
      if (method === "tx") {
        const p = params as [string, string];
        const out = txOutcomes[p[0]];
        if (!out) throw new RpcError({ code: -32000, message: "tx not found" });
        return out as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { client, blocks, chunks, txOutcomes, calls };
}

const CONTRACT = "snacc-v001.testnet";
const FED_EVENT = 'EVENT_JSON:{"standard":"snacc","version":"1.0.0","event":"fed","data":[{"kind":"fed","strain_id":1,"effective_fee":900,"atp_minted":2}]}';
const CALLBACK_EVENT = 'EVENT_JSON:{"standard":"snacc","version":"1.0.0","event":"subaccount_materialized","data":[{"kind":"subaccount_materialized","strain_id":1,"sub_account_id":"s-1-0.snacc-v001.testnet"}]}';

const txOutcome = (txLogs: string[], receiptLogs: string[][]) => ({
  transaction_outcome: { outcome: { logs: txLogs } },
  receipts_outcome: receiptLogs.map((logs, i) => ({ receipt_id: `rc-${i}`, outcome: { logs } })),
  transaction: { hash: "T1" },
});

test("first poll starts at the head, reads the contract's txs, and absorbs their events", async () => {
  const fx = fixtureClient(
    { 100: ["c100"] },
    {
      c100: {
        transactions: [
          { hash: "T1", receiver_id: CONTRACT, signer_id: "user.testnet" },
          { hash: "TX-other", receiver_id: "other.testnet", signer_id: "user.testnet" }, // not our contract
        ],
      },
    },
    {
      T1: txOutcome([FED_EVENT], [[CALLBACK_EVENT]]),
    },
  );
  const store = newEventStore();
  const state = newPollerState();
  await pollOnce(fx.client, CONTRACT, store, state);
  assert.equal(state.headHeight, 100);
  assert.equal(state.cursorHeight, 100);
  assert.equal(state.caughtUp, true);
  assert.equal(store.indexerComplete, true);
  assert.equal(state.processedTx, 1); // only the contract's own tx
  assert.deepEqual(store.events.map((e) => e.kind), ["fed", "subaccount_materialized"]);
  assert.equal(store.events[0]!.block_height, 100);
  assert.deepEqual([...state.recheck], ["T1"]);
  assert.equal(indexerLagBlocks(state), 0);
});

test("the recheck pass on the next tick absorbs delayed callback receipts without duplicates", async () => {
  const fx = fixtureClient(
    { 100: ["c100"] },
    { c100: { transactions: [{ hash: "T1", receiver_id: CONTRACT, signer_id: "u.testnet" }] } },
    {
      T1: txOutcome([FED_EVENT], []), // the callback receipt does not exist yet
    },
  );
  const store = newEventStore();
  const state = newPollerState();
  await pollOnce(fx.client, CONTRACT, store, state);
  assert.deepEqual(store.events.map((e) => e.kind), ["fed"]);

  // Next tick: the delayed callback receipt is now visible; the head also advanced with a new tx.
  fx.txOutcomes["T1"] = txOutcome([FED_EVENT], [[CALLBACK_EVENT]]);
  fx.blocks[101] = ["c101"];
  fx.chunks["c101"] = { transactions: [{ hash: "T2", receiver_id: CONTRACT, signer_id: "u.testnet" }] };
  fx.txOutcomes["T2"] = txOutcome([FED_EVENT], []);
  await pollOnce(fx.client, CONTRACT, store, state);
  assert.deepEqual(store.events.map((e) => e.kind), [
    "fed",
    "subaccount_materialized", // from the T1 recheck
    "fed", // T2
  ]);
  assert.equal(state.processedTx, 2);
  assert.deepEqual(state.recheck, ["T2"]);
  // The fed event from T1 was NOT re-absorbed (receipt-level dedupe).
  assert.equal(store.events.length, 3);
  assert.equal(state.caughtUp, true);
});

test("absorbTxOutcome does not re-absorb already-seen receipts", () => {
  const store = newEventStore();
  const state = newPollerState();
  const result = txOutcome([FED_EVENT], [[CALLBACK_EVENT]]);
  assert.equal(absorbTxOutcome(store, state, "T1", result, 5), 2);
  assert.equal(absorbTxOutcome(store, state, "T1", result, 5), 0);
  assert.equal(store.events.length, 2);
});

test("catch-up is bounded by MAX_BLOCKS_PER_TICK per poll", async () => {
  const blocks: Record<number, string[]> = {};
  for (let h = 100; h <= 120; h++) blocks[h] = [];
  const fx = fixtureClient(blocks, {});
  const store = newEventStore();
  const state: PollerState = newPollerState();
  await pollOnce(fx.client, CONTRACT, store, state); // cursor = 120 (the head)
  assert.equal(state.cursorHeight, 120);

  // The head jumps 60 blocks ahead (> MAX_BLOCKS_PER_TICK).
  for (let h = 121; h <= 180; h++) fx.blocks[h] = [];
  await pollOnce(fx.client, CONTRACT, store, state); // processes 121..170 only (50 blocks)
  assert.equal(state.cursorHeight, 170);
  assert.equal(state.caughtUp, false);
  assert.equal(indexerLagBlocks(state), 10);
  await pollOnce(fx.client, CONTRACT, store, state); // finishes the tail 171..180
  assert.equal(state.cursorHeight, 180);
  assert.equal(state.caughtUp, true);
  assert.equal(indexerLagBlocks(state), 0);
});

test("RPC failure (429 after retries) keeps the cursor and marks the store incomplete", async () => {
  const fx = fixtureClient(
    { 100: ["c100"] },
    { c100: { transactions: [{ hash: "T1", receiver_id: CONTRACT, signer_id: "u.testnet" }] } },
    { T1: txOutcome([FED_EVENT], []) },
  );
  const store = newEventStore();
  const state = newPollerState();
  await pollOnce(fx.client, CONTRACT, store, state);
  assert.equal(state.cursorHeight, 100);
  assert.equal(store.indexerComplete, true);

  // The head advances to 101 with a contract tx, but `tx` calls now return 429.
  fx.blocks[101] = ["c101"];
  fx.chunks["c101"] = { transactions: [{ hash: "T2", receiver_id: CONTRACT, signer_id: "u.testnet" }] };
  const failing = fixtureClient(fx.blocks, fx.chunks, fx.txOutcomes, {
    failOn: "tx",
    rpcError: { code: -32000, message: "HTTP 429 from RPC" },
  });
  await assert.rejects(pollOnce(failing.client, CONTRACT, store, state), /429/);
  assert.equal(state.cursorHeight, 100); // unchanged — no skip
  assert.equal(state.caughtUp, false);
  assert.match(state.lastError ?? "", /429/);
  assert.equal(store.indexerComplete, false); // honest: incomplete while failing
  assert.equal(store.events.length, 1);
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
