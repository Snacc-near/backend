/**
 * NEP-297 event poller (INT-102/INT-104). The recorded decision (`docs/indexer-decision.md`,
 * option E): read `EVENT_JSON` from the `tx` execution outcome via the public JSON-RPC
 * (0 API keys). Per tick: discover the contract's transactions block by block
 * (block → chunks → chunk.transactions filtered by `receiver_id === contractId`), fetch each
 * transaction's full outcome tree (`tx` = transaction_outcome + receipts_outcome), and absorb
 * every NEP-297 event into the in-memory store.
 *
 * - Per-block cursor: every fully processed block advances `cursorHeight`; a tick processes at
 *   most `MAX_BLOCKS_PER_TICK` blocks so catch-up is bounded.
 * - Callback events (e.g. `subaccount_materialized` from a cross-contract promise) can execute in
 *   a later block than the triggering tx; each tx is therefore re-queried on the next tick
 *   (`recheck`, one extra pass) before being considered final.
 * - 429/502/503/504 retry + exponential backoff live in `NearRpcClient`; when retries are
 *   exhausted, `pollOnce` records `lastError` and keeps the cursor (no data loss, no skip).
 * - Memory bounds: the event store caps retained events (`MAX_EVENTS`); the seen-receipt and
 *   recheck sets are pruned to bounded sizes.
 */

import { collectEventsFromChunk, absorbEvent, type EventStore } from "./events.js";

/** The slice of `NearRpcClient` the poller needs (injected as a stub in unit tests). */
export interface PollerRpc {
  fetchJsonRpc<T>(method: string, params: unknown): Promise<T>;
}

export interface PollerState {
  /** Height of the last fully processed block; `null` until the first poll. */
  cursorHeight: number | null;
  /** Last observed final-block head height. */
  headHeight: number | null;
  /** Last poll error message; `null` when the last poll succeeded. */
  lastError: string | null;
  /** True when the cursor has reached the observed head and the last poll succeeded. */
  caughtUp: boolean;
  /** Distinct contract transactions processed (counter). */
  processedTx: number;
  /** Receipts already absorbed, as `${txHash}:${receiptId}` (bounded; pruned oldest-first). */
  seenReceipts: Set<string>;
  /** Tx hashes queued for one re-query on the next tick (delayed callback receipts). */
  recheck: string[];
}

export function newPollerState(): PollerState {
  return {
    cursorHeight: null,
    headHeight: null,
    lastError: null,
    caughtUp: false,
    processedTx: 0,
    seenReceipts: new Set(),
    recheck: [],
  };
}

/** Catch-up bound per tick: at most this many blocks are processed in one `pollOnce`. */
export const MAX_BLOCKS_PER_TICK = 50;
/** Bounded memory: at most this many receipt ids are remembered for dedupe. */
const MAX_SEEN_RECEIPTS = 20000;
/** At most this many txs get their one re-query pass per tick. */
const MAX_RECHECK_PER_TICK = 25;
/** At most this many new contract txs are fetched per tick (a burst guard). */
const MAX_NEW_TX_PER_TICK = 50;

interface BlockResult {
  header: { height: number };
  /** The chunks included in this block (one per shard; NEAR names the hash `chunk_hash`). */
  chunks: Array<{ chunk_hash?: string; chunk_id?: string }>;
}

interface ChunkResult {
  /** Direct transactions in the chunk; the contract's events start from these. */
  transactions?: Array<{ hash: string; receiver_id: string; signer_id: string }>;
  receipts?: unknown[];
}

interface TxOutcomeResult {
  transaction_outcome?: { outcome?: { logs?: string[] } };
  receipts_outcome?: Array<{ receipt_id?: string; outcome?: { logs?: string[] } }>;
  transaction?: { hash: string };
}

/** Lag in blocks between the observed chain head and the processed cursor. */
export function indexerLagBlocks(state: PollerState): number | null {
  if (state.headHeight === null) return null;
  if (state.cursorHeight === null) return null;
  return Math.max(0, state.headHeight - state.cursorHeight);
}

function rememberReceipt(state: PollerState, key: string): boolean {
  if (state.seenReceipts.has(key)) return false;
  state.seenReceipts.add(key);
  while (state.seenReceipts.size > MAX_SEEN_RECEIPTS) {
    const oldest = state.seenReceipts.values().next().value;
    if (oldest === undefined) break;
    state.seenReceipts.delete(oldest);
  }
  return true;
}

/**
 * Absorb every not-yet-seen receipt's events from a `tx` outcome result.
 * Returns the number of newly absorbed events.
 */
export function absorbTxOutcome(
  store: EventStore,
  state: PollerState,
  txHash: string,
  result: TxOutcomeResult,
  blockHeight: number,
): number {
  let absorbed = 0;
  const receipts = [
    {
      receipt_id: `tx:${txHash}`,
      logs: result.transaction_outcome?.outcome?.logs ?? [],
    },
    ...(result.receipts_outcome ?? []).map((r) => ({
      receipt_id: r.receipt_id ?? `unknown:${absorbed}`,
      logs: r.outcome?.logs ?? [],
    })),
  ];
  for (const receipt of receipts) {
    const key = `${txHash}:${receipt.receipt_id}`;
    if (!rememberReceipt(state, key)) continue;
    for (const ev of collectEventsFromChunk({ receipts: [{ receipt_id: receipt.receipt_id, outcome: { logs: receipt.logs } }] })) {
      ev.block_height = blockHeight;
      absorbEvent(store, ev);
      absorbed++;
    }
  }
  return absorbed;
}

async function fetchTxOutcome(rpc: PollerRpc, txHash: string, receiverId: string): Promise<TxOutcomeResult> {
  // The `tx` RPC takes positional [tx_hash, account_id] params.
  return rpc.fetchJsonRpc<TxOutcomeResult>("tx", [txHash, receiverId]);
}

/**
 * Poll once: discover + fetch the contract's transactions in the unprocessed blocks (bounded),
 * absorb their NEP-297 events, run one bounded recheck pass for delayed callback receipts,
 * and advance the cursor. Throws on RPC failure after built-in retries;
 * `state.lastError` is set before rethrowing so the caller can log it.
 */
export async function pollOnce(
  rpc: PollerRpc,
  contractId: string,
  store: EventStore,
  state: PollerState,
): Promise<PollerState> {
  try {
    const head = await rpc.fetchJsonRpc<BlockResult>("block", { finality: "final" });
    if (typeof head?.header?.height !== "number" || !Array.isArray(head.chunks)) {
      throw new Error("malformed block result");
    }
    state.headHeight = head.header.height;

    // 1) One recheck pass: txs from the previous tick may have executed their callback receipts by now.
    const recheckNow = state.recheck.splice(0, MAX_RECHECK_PER_TICK);
    for (const txHash of recheckNow) {
      const result = await fetchTxOutcome(rpc, txHash, contractId);
      absorbTxOutcome(store, state, txHash, result, state.cursorHeight ?? head.header.height);
    }

    // 2) Discover contract txs in the unprocessed blocks and fetch their outcome trees.
    // First poll: start at the head (no unbounded backfill). Later polls: catch up.
    const start = state.cursorHeight === null ? head.header.height : state.cursorHeight + 1;
    const end = Math.min(head.header.height, start + MAX_BLOCKS_PER_TICK - 1);

    for (let height = start; height <= end; height++) {
      const block = await rpc.fetchJsonRpc<BlockResult>("block", { block_id: height });
      if (typeof block?.header?.height !== "number" || !Array.isArray(block.chunks)) {
        throw new Error(`malformed block result at height ${height}`);
      }
      const chunkIds = block.chunks
        .map((c) => c.chunk_hash ?? c.chunk_id)
        .filter((id): id is string => typeof id === "string");
      for (const chunkId of chunkIds) {
        const chunk = await rpc.fetchJsonRpc<ChunkResult>("chunk", { chunk_id: chunkId });
        const txs = (chunk.transactions ?? []).filter((t) => t.receiver_id === contractId);
        for (const tx of txs) {
          const result = await fetchTxOutcome(rpc, tx.hash, contractId);
          absorbTxOutcome(store, state, tx.hash, result, height);
          state.processedTx += 1;
          state.recheck.push(tx.hash); // one re-query next tick for delayed callbacks
          while (state.recheck.length > MAX_RECHECK_PER_TICK * 2) state.recheck.shift();
        }
      }
      state.cursorHeight = height;
    }

    state.caughtUp = state.cursorHeight !== null && state.cursorHeight >= head.header.height;
    state.lastError = null;
    store.indexerComplete = state.caughtUp;
  } catch (err) {
    state.lastError = String(err instanceof Error ? err.message : err);
    state.caughtUp = false;
    store.indexerComplete = false;
    throw err;
  }
  return state;
}
