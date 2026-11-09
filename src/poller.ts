/**
 * NEP-297 event poller v2 (INT-102/INT-104). Budget-friendly redesign of the block scanner:
 * the previous version fetched every block × every chunk on the free public RPC (≈10+ calls
 * per block) and exhausted its 429 quota within a minute of live deployment. The recorded
 * decision (`docs/indexer-decision.md`, option E) stays: parse `EVENT_JSON` from `tx` outcomes.
 * What changes is the DISCOVERY source:
 *
 * - Discovery = the NearBlocks v3 API (`GET {discoveryUrl}` = `/v3/accounts/<contract>/txns`,
 *   no API key, newest-first). ONE discovery call per poll tick (≈4/min at the 15 s interval —
 *   empirically the unauthenticated limit allows a burst of ~4 requests and recovers in ~12 s).
 * - Logs = the plain NEAR RPC `tx` per NEW contract transaction (budget: ≤ `maxTxPerTick` per
 *   tick), which returns the full outcome tree (`transaction_outcome` + `receipts_outcome`),
 *   including the cross-contract callback receipts.
 * - Global exponential backoff: any 429/5xx/network failure (either source) arms a backoff
 *   (base = the poll interval, doubling per consecutive failure, cap 10 min) — ticks inside the
 *   backoff window make NO API calls at all, so the other view endpoints keep their RPC budget.
 * - Cursor: the newest ABSORBED tx's `(block_timestamp_ns, block_height)` + bounded dedupe sets
 *   for txs and receipts; the cursor only advances AFTER the logs are absorbed (a crash
 *   mid-tick re-discovers the queued txs — no silent loss, and `indexer_incomplete` says so).
 * - Honest state: `indexer_incomplete` is `true` while the discovery source is failing, backing
 *   off, or the backfill queue is not drained; the lag header = chain head − the newest
 *   absorbed tx's block (documented meaning: with a quiet contract it grows because there is
 *   genuinely no recent activity — the health signal is `indexer_incomplete`).
 */

import { absorbEvent, extractEventsFromLogs, type EventStore } from "./events.js";

/** The slice of `NearRpcClient` the poller needs (injected as a stub in unit tests). */
export interface PollerRpc {
  fetchJsonRpc<T>(method: string, params: unknown): Promise<T>;
}

/** Minimal fetch shape for the discovery source (injectable for tests). */
export type DiscoveryFetch = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface PollerState {
  /** `block_timestamp` (ns) of the newest ABSORBED tx; `null` until the first absorption. */
  cursorTimestampNs: string | null;
  /** Block height of the newest ABSORBED tx; `null` until the first absorption. */
  cursorHeight: number | null;
  /** Last observed chain head (final). */
  headHeight: number | null;
  /** head − the newest absorbed tx's block; `null` when nothing was absorbed yet. */
  lagBlocks: number | null;
  /** Last poll error message; `null` when the last poll succeeded. */
  lastError: string | null;
  /** True when the last poll succeeded and no catch-up work remains. */
  caughtUp: boolean;
  /** Distinct contract txs whose outcome tree was fetched (counter). */
  processedTx: number;
  /** Ticks skipped because the global backoff was active. */
  backedOffTicks: number;
  /** Discovery/tx failures counted since start (429/5xx). */
  rateLimitedErrors: number;
  /** Absorb until this epoch-ms before polling again (global exponential backoff). */
  backoffUntilMs: number;
  /** Current backoff attempt counter (reset on success). */
  backoffAttempts: number;
  /** Pending txs discovered but not yet absorbed (oldest first; bounded). */
  queue: Array<{ hash: string; receiver: string; timestampNs: string; height: number }>;
  /** Tx hashes already discovered (bounded dedupe set). */
  seenTx: Set<string>;
  /** `${txHash}:${receiptId}` pairs already absorbed (bounded dedupe set). */
  seenReceipts: Set<string>;
}

export function newPollerState(): PollerState {
  return {
    cursorTimestampNs: null,
    cursorHeight: null,
    headHeight: null,
    lagBlocks: null,
    lastError: null,
    caughtUp: false,
    processedTx: 0,
    backedOffTicks: 0,
    rateLimitedErrors: 0,
    backoffUntilMs: 0,
    backoffAttempts: 0,
    queue: [],
    seenTx: new Set(),
    seenReceipts: new Set(),
  };
}

/** Discovery page size: the first (backfill) call fetches 50, later calls 25. */
export const BACKFILL_LIMIT = 50;
const DISCOVERY_LIMIT = 25;
/** Bounded memory: at most this many tx hashes are remembered for dedupe. */
const MAX_SEEN_TX = 2000;
/** Bounded memory: at most this many receipt ids are remembered for dedupe. */
const MAX_SEEN_RECEIPTS = 20000;
/** Bounded queue: drop the oldest pending tx beyond this. */
const MAX_QUEUE = 100;
/** Backoff: base delay (ms) after the first failure, doubling per consecutive failure. */
export const BACKOFF_BASE_MS = 15000;
/** Backoff cap. */
export const BACKOFF_MAX_MS = 600000;

interface DiscoveryTx {
  transaction_hash: string;
  receiver_account_id: string;
  signer_account_id: string;
  block_timestamp: string; // nanoseconds as a string
  block: { block_height: string };
}

interface DiscoveryResult {
  data?: DiscoveryTx[] | null;
}

interface TxOutcomeResult {
  // The `tx` RPC (`EXPERIMENTAL_tx_status`) names the receipt identifier `id`
  // (verified live against testnet: receipts_outcome[].id + transaction_outcome.id);
  // `receipt_id` is kept only as a legacy fallback for older/other fixtures.
  transaction_outcome?: { id?: string; outcome?: { logs?: string[] } };
  receipts_outcome?: Array<{
    id?: string;
    receipt_id?: string;
    outcome?: { logs?: string[] };
  }>;
}

function rememberSet(set: Set<string>, key: string, max: number): boolean {
  if (set.has(key)) return false;
  set.add(key);
  while (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
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
      // Real id from the RPC (`transaction_outcome.id`, equal to the tx hash);
      // `tx:<hash>` stays as the safe fallback when the field is absent.
      receipt_id: result.transaction_outcome?.id ?? `tx:${txHash}`,
      logs: result.transaction_outcome?.outcome?.logs ?? [],
    },
    ...(result.receipts_outcome ?? []).map((r, i) => ({
      // Real id first (`id`, verified against the live `tx` RPC shape), then the
      // legacy `receipt_id`, then a stable last resort. The dedupe key below
      // always carries the tx hash, so `unknown:${i}` can never collide across txs.
      receipt_id: r.id ?? r.receipt_id ?? `unknown:${i}`,
      logs: r.outcome?.logs ?? [],
    })),
  ];
  for (const receipt of receipts) {
    const key = `${txHash}:${receipt.receipt_id}`;
    if (!rememberSet(state.seenReceipts, key, MAX_SEEN_RECEIPTS)) continue;
    for (const ev of extractEventsFromLogs(receipt.logs)) {
      ev.receipt_id = receipt.receipt_id;
      ev.block_height = blockHeight;
      absorbEvent(store, ev);
      absorbed++;
    }
  }
  return absorbed;
}

function refreshLag(state: PollerState): void {
  state.lagBlocks =
    state.headHeight === null || state.cursorHeight === null
      ? null
      : Math.max(0, state.headHeight - state.cursorHeight);
}

/**
 * Poll once with a small RPC budget:
 * 1. discovery (1 NearBlocks call) → new contract txs newest-first;
 * 2. the chain head (1 `block` call) → lag;
 * 3. absorb up to `maxTxPerTick` queued txs (1 `tx` call each).
 * When either source 429s/fails, a global exponential backoff is armed and the state is
 * marked incomplete (honest). Transport failures are recorded in `state.lastError`; this
 * function does not throw for them.
 */
export async function pollOnce(
  rpc: PollerRpc,
  discoveryFetch: DiscoveryFetch,
  contractId: string,
  store: EventStore,
  state: PollerState,
  nowMs: number = Date.now(),
  maxTxPerTick = 5,
): Promise<PollerState> {
  // Global backoff: skip this tick entirely (no API calls) while armed.
  if (nowMs < state.backoffUntilMs) {
    state.backedOffTicks += 1;
    state.caughtUp = false;
    store.indexerComplete = false;
    return state;
  }

  const fail = (msg: string, isRateLimit: boolean): void => {
    state.lastError = msg;
    state.caughtUp = false;
    if (isRateLimit) state.rateLimitedErrors += 1;
    state.backoffAttempts += 1;
    state.backoffUntilMs =
      nowMs + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(state.backoffAttempts, 10));
    store.indexerComplete = false; // honest: the indexer is behind/failing
  };

  // 1) Discovery: new contract txs, newest first.
  let discovered: DiscoveryTx[];
  try {
    const limit = state.cursorTimestampNs === null ? BACKFILL_LIMIT : DISCOVERY_LIMIT;
    const res = await discoveryFetch(`${pollerDiscoveryUrl(contractId)}?limit=${limit}`);
    if (!res.ok) {
      fail(`discovery HTTP ${res.status}`, res.status === 429);
      return state;
    }
    const body = (await res.json()) as DiscoveryResult;
    discovered = Array.isArray(body.data) ? body.data : [];
  } catch (err) {
    fail(`discovery failed: ${String(err instanceof Error ? err.message : err)}`, false);
    return state;
  }

  // 2) Queue the not-yet-seen txs OLDEST FIRST (the feed is newest-first, so iterate backwards);
  // the cursor advances only after absorption.
  for (const tx of [...discovered].reverse()) {
    if (!tx.transaction_hash || !tx.block?.block_height) continue;
    if (tx.receiver_account_id !== contractId && tx.signer_account_id !== contractId) continue;
    if (!rememberSet(state.seenTx, tx.transaction_hash, MAX_SEEN_TX)) continue;
    state.queue.push({
      hash: tx.transaction_hash,
      receiver: tx.receiver_account_id === contractId ? tx.receiver_account_id : tx.signer_account_id,
      timestampNs: String(tx.block_timestamp),
      height: Number(tx.block.block_height),
    });
    while (state.queue.length > MAX_QUEUE) state.queue.shift(); // drop the oldest pending
  }

  // 3) The chain head (1 `block` call) → lag.
  try {
    const head = await rpc.fetchJsonRpc<{ header?: { height?: number } }>("block", { finality: "final" });
    const h = head?.header?.height;
    if (typeof h !== "number") throw new Error("malformed block result");
    state.headHeight = h;
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    fail(`head failed: ${msg}`, /429/.test(msg));
    return state;
  }

  // 4) Absorb the queued txs oldest-first, within the per-tick budget (1 `tx` call each).
  while (state.queue.length > 0 && maxTxPerTick > 0) {
    const item = state.queue.shift()!;
    maxTxPerTick -= 1;
    try {
      // The `tx` RPC takes positional [tx_hash, account_id] params.
      const result = await rpc.fetchJsonRpc<TxOutcomeResult>("tx", [item.hash, item.receiver]);
      absorbTxOutcome(store, state, item.hash, result, item.height);
      state.processedTx += 1;
      // The cursor advances only after absorption (a crash before this re-discovers the tx).
      if (state.cursorTimestampNs === null || BigInt(item.timestampNs) > BigInt(state.cursorTimestampNs)) {
        state.cursorTimestampNs = item.timestampNs;
        state.cursorHeight = item.height;
      }
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      fail(`tx ${item.hash.slice(0, 10)}… failed: ${msg}`, /429/.test(msg));
      // Put the tx back at the front of the queue (it stays pending, no silent loss).
      state.queue.unshift(item);
      refreshLag(state);
      return state;
    }
  }

  state.caughtUp = state.queue.length === 0;
  state.lastError = null;
  state.backoffAttempts = 0;
  store.indexerComplete = state.caughtUp;
  refreshLag(state); // stays fresh even when the contract is quiet
  return state;
}

/**
 * Run one poll tick under a watchdog: a hanging discovery/RPC (a fetch that never settles)
 * must end as a recorded failure + backoff, not an endless block of the poll loop.
 * The underlying `pollOnce` keeps running after the timeout, so it is tracked per state: while
 * it has not settled, later ticks are skipped (counted in `backedOffTicks`) — never overlapped.
 */
const inFlightPolls = new WeakMap<PollerState, Promise<unknown>>();

export async function pollTick(
  rpc: PollerRpc,
  discoveryFetch: DiscoveryFetch,
  contractId: string,
  store: EventStore,
  state: PollerState,
  opts: { nowMs?: number; maxTxPerTick?: number; tickTimeoutMs?: number } = {},
): Promise<void> {
  if (inFlightPolls.has(state)) {
    // A previous pollOnce outlived its watchdog and is still running: skip, do not overlap.
    state.backedOffTicks += 1;
    return;
  }
  const timeoutMs = opts.tickTimeoutMs ?? 30000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poll = pollOnce(rpc, discoveryFetch, contractId, store, state, opts.nowMs, opts.maxTxPerTick);
  inFlightPolls.set(state, poll);
  poll.then(
    () => inFlightPolls.delete(state),
    () => inFlightPolls.delete(state),
  );
  try {
    await Promise.race([
      poll,
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`poll tick timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (err) {
    // A timed-out tick is a failure like any other: record it honestly and arm the backoff
    // (the in-flight pollOnce, if any, may still mutate state later — the caller skips ticks
    // while a previous one is in flight, so there is no overlap).
    state.lastError = String(err instanceof Error ? err.message : err);
    state.caughtUp = false;
    store.indexerComplete = false;
    state.backoffAttempts += 1;
    const now = opts.nowMs ?? Date.now();
    state.backoffUntilMs =
      now + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(state.backoffAttempts, 10));
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The NearBlocks v3 discovery URL for one account (no API key required). */
export function pollerDiscoveryUrl(contractId: string): string {
  return `https://api-testnet.nearblocks.io/v3/accounts/${contractId}/txns`;
}
