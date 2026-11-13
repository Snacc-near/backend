/**
 * Contract-wide chain index (UI-155, UI-156).
 *
 * The Snacc contract stores no parent ids: divide / splice / hostile takeover / adopt / harvest / feed facts exist only as
 * NEP-297 `EVENT_JSON:` logs in transaction receipts. `chain-index` lists the transactions to the contract (NearBlocks API v3),
 * fetches each outcome with `EXPERIMENTAL_tx_status`, and stores every event of a successful receipt in `chain_events_snacc`.
 *
 * Everything here is pure TypeScript (fetch / BigInt only) so it runs in Deno and in Node tests. The Edge Function entry point
 * (`chain-index/index.ts`) only wires the I/O: NearBlocks, the NEAR RPC and Supabase.
 *
 * State generations: `migrate()` and `new()` reset the contract state (strain ids start again at 1). A successful call of either
 * is stored as a pseudo event `snacc-index / state_reset`; the SQL views only look at events from the latest reset onwards.
 */

import { NearRpc, NearRpcError } from "./near-rpc.ts";

export const EVENT_PREFIX = "EVENT_JSON:";
/** NEP-297 standard of `snacc-market.testnet` (listed / sold / delisted / price_updated). */
export const MARKET_STANDARD = "snacc_market";
export const DEFAULT_MARKET_ID = "snacc-market.testnet";
/** Pseudo standard for facts the indexer derives itself (not a contract log). */
export const INDEX_STANDARD = "snacc-index";
export const STATE_RESET_EVENT = "state_reset";
/** Contract methods that wipe the strain state (new prefix generation, `next_strain_id` back to 1). */
export const STATE_RESET_METHODS: readonly string[] = ["migrate", "new"];

/** A tx older than this is asked from the archival node first (regular nodes keep ~5 epochs and answer slowly for older ones). */
export const ARCHIVAL_AGE_MS = 36 * 3600 * 1000;
/** Re-list this much history before the stored head so a tx NearBlocks indexed late (other shard, indexer lag) is not lost. */
export const LOOKBACK_NS = 5n * 60n * 1_000_000_000n;
export const MAX_RETRY_ATTEMPTS = 5;
export const MAX_DEAD_ENTRIES = 50;
/** Retries are attempted before new work, at most this many per run. */
export const MAX_RETRIES_PER_RUN = 10;
const MAX_LOG_CHARS = 20_000;

// ---------------------------------------------------------------------------------------------
// EVENT_JSON parsing
// ---------------------------------------------------------------------------------------------

/**
 * Wrap integer literals with 16+ digits in quotes (outside strings) so `JSON.parse` keeps them exact.
 * The contract prints u128 amounts as raw JSON numbers (e.g. `"fee":390550000000000000000`), far beyond 2^53.
 */
export function quoteBigInts(json: string): string {
  let out = "";
  let i = 0;
  const n = json.length;
  while (i < n) {
    const c = json[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < n && json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      out += json.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < n && (json[j] as string) >= "0" && (json[j] as string) <= "9") j++;
      const next = json[j];
      const isInt = next !== "." && next !== "e" && next !== "E";
      const digits = json.slice(i, j).replace("-", "");
      if (isInt && digits.length >= 16) {
        out += `"${json.slice(i, j)}"`;
        i = j;
        continue;
      }
      // a short integer or a decimal/exponent number: copy the whole token
      while (j < n && /[0-9.eE+-]/.test(json[j] as string)) j++;
      out += json.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

export interface ParsedEvent {
  standard: string;
  version: string;
  event: string;
  /** `data[0]` of the NEP-297 envelope (the contract always emits exactly one element). 16+ digit integers are strings. */
  data: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Parse one log line; `null` when it is not an `EVENT_JSON:` line or not a well-formed one-element NEP-297 event. */
export function parseEventLine(line: string): ParsedEvent | null {
  if (typeof line !== "string" || !line.startsWith(EVENT_PREFIX) || line.length > MAX_LOG_CHARS) return null;
  let v: unknown;
  try {
    v = JSON.parse(quoteBigInts(line.slice(EVENT_PREFIX.length)));
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  const { standard, version, event, data } = v;
  if (typeof standard !== "string" || typeof version !== "string" || typeof event !== "string") return null;
  if (standard === "" || event === "" || standard.length > 40 || event.length > 80 || version.length > 20) return null;
  if (!Array.isArray(data) || data.length !== 1 || !isRecord(data[0])) return null;
  return { standard, version, event, data: data[0] };
}

/** Strain ids and generations are u64 (19 digits); amounts are u128 (39 digits, printed as raw JSON numbers by the contract). */
const INT = /^\d{1,19}$/;
const AMOUNT = /^\d{1,39}$/;
const isIdKey = (k: string): boolean => k === "strain_id" || k.endsWith("_id") || k.endsWith("generation");
const asIntText = (k: string, v: unknown): boolean =>
  (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) || (typeof v === "string" && (isIdKey(k) ? INT : AMOUNT).test(v));

/** Fields the SQL views cast: ids must be integers, amounts integers, so one bad row can never break a view. */
const REQUIRED_INTS: Record<string, readonly string[]> = {
  strain_created: ["strain_id", "initial_snacc_stake"],
  fed: ["strain_id", "effective_fee"],
  extracted: ["strain_id", "amount"],
  transmuted: ["strain_id", "minted"],
  synthesized: ["strain_id", "minted"],
  genome_committed: ["strain_id"],
  genome_mutated: ["strain_id", "vitality_bonus"],
  atp_allocated: ["strain_id", "cost"],
  aether_burned_for_dividend: ["strain_id", "amount"],
  dividend_claimed: ["strain_id", "payout"],
  npc_spores_bought: ["strain_id", "total_cost"],
  strain_divided: ["parent_id", "child_id", "child_generation", "child_balance"],
  strains_spliced: ["dominant_id", "absorbed_id", "merger_tax"],
  hostile_takeover_spliced: ["raider_id", "target_id", "payment"],
  strain_adopted: ["target_id", "raider_strain_id", "book_value"],
  strain_liquidated: ["target_id", "bounty"],
  trait_conjugated: ["from_strain_id", "to_strain_id"],
};

/** Market events (`snacc-market.testnet`): amounts are the `price` fields; `token_id` is a decimal string. */
const MARKET_AMOUNTS: Record<string, readonly string[]> = {
  listed: ["price"],
  sold: ["price"],
  price_updated: ["old_price", "new_price"],
  delisted: [],
};

/** Event-specific shape check; unknown events (and `nep141` ones) pass through untouched. */
export function isWellFormed(e: ParsedEvent): boolean {
  if (e.standard === "nep171" && e.event === "nft_transfer") {
    const ids = e.data["token_ids"];
    return Array.isArray(ids) && ids.length > 0 && ids.every((t) => typeof t === "string" && INT.test(t));
  }
  if (e.standard === MARKET_STANDARD) {
    const amounts = MARKET_AMOUNTS[e.event];
    if (!amounts) return true;
    const tokenId = e.data["token_id"];
    if (typeof tokenId !== "string" || !INT.test(tokenId) || typeof e.data["seller_id"] !== "string") return false;
    if (e.event === "sold" && typeof e.data["buyer_id"] !== "string") return false;
    return amounts.every((k) => asIntText(k, e.data[k]));
  }
  if (e.standard !== "snacc") return true;
  const required = REQUIRED_INTS[e.event];
  if (!required) return true;
  if (!required.every((k) => asIntText(k, e.data[k]))) return false;
  if (e.event === "strain_adopted" && typeof e.data["adopter"] !== "string") return false;
  if (e.event === "strain_liquidated" && typeof e.data["liquidator"] !== "string") return false;
  if (e.event === "strain_created" && typeof e.data["owner_id"] !== "string") return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Receipts -> rows
// ---------------------------------------------------------------------------------------------

export interface ChainEventRow {
  tx_hash: string;
  receipt_id: string;
  log_index: number;
  standard: string;
  version: string;
  event: string;
  data: Record<string, unknown>;
  signer_id: string;
  block_height: number;
  block_time: string;
}

export interface TxContext {
  txHash: string;
  signerId: string;
  blockHeight: number;
  /** ISO timestamp of the block that included the tx. */
  blockTime: string;
}

export interface Extracted {
  events: ChainEventRow[];
  /** `EVENT_JSON:` lines that were not well-formed events (counted, never stored). */
  malformed: number;
}

function receiptSucceeded(status: unknown): boolean {
  return isRecord(status) && ("SuccessValue" in status || "SuccessReceiptId" in status);
}

/** The accounts whose receipts carry events we index: the Snacc contract and (optionally) the market contract. */
export interface EventSources {
  snacc: string;
  /** `null` = the market is not indexed. */
  market: string | null;
}

/** `SNACC_MARKET_CONTRACT_ID` overrides the market account; `none` / `off` / `-` disables market indexing. */
export function resolveMarketId(getEnv: (k: string) => string | undefined): string | null {
  const v = getEnv("SNACC_MARKET_CONTRACT_ID")?.trim();
  if (!v) return DEFAULT_MARKET_ID;
  return ["none", "off", "-"].includes(v.toLowerCase()) ? null : v;
}

/**
 * Events of every SUCCESSFUL receipt in an `EXPERIMENTAL_tx_status` result: anything the Snacc contract logged (except the
 * market standard) and the `snacc_market` events of the market contract. A market `buy` / `delist` tx carries both (the market
 * calls `nft_transfer` on the Snacc contract), and a listing tx (`nft_transfer_call` on the Snacc contract) carries `listed`.
 * Logs of a failed receipt are ignored (a panic keeps the logs emitted before it, but the state change is rolled back).
 * `log_index` is the position in that receipt's `logs` array (non-event logs count), so rows are stable across re-runs.
 * A plain string means "the Snacc contract only".
 */
export function extractEvents(result: unknown, ctx: TxContext, sources: string | EventSources): Extracted {
  const src: EventSources = typeof sources === "string" ? { snacc: sources, market: null } : sources;
  const out: Extracted = { events: [], malformed: 0 };
  if (!isRecord(result)) return out;
  const outcomes = Array.isArray(result["receipts_outcome"]) ? result["receipts_outcome"] : [];
  for (const ro of outcomes) {
    if (!isRecord(ro) || typeof ro["id"] !== "string") continue;
    const outcome = ro["outcome"];
    if (!isRecord(outcome) || !receiptSucceeded(outcome["status"])) continue;
    const executor = outcome["executor_id"];
    const isSnacc = executor === src.snacc;
    const isMarket = src.market !== null && executor === src.market;
    if (!isSnacc && !isMarket) continue;
    const logs = Array.isArray(outcome["logs"]) ? outcome["logs"] : [];
    logs.forEach((line, idx) => {
      if (typeof line !== "string" || !line.startsWith(EVENT_PREFIX)) return;
      const parsed = parseEventLine(line);
      // each contract only speaks for its own standard(s): the market only `snacc_market`, the Snacc contract anything else
      if (parsed && (parsed.standard === MARKET_STANDARD) !== isMarket) return;
      if (!parsed || !isWellFormed(parsed)) {
        out.malformed++;
        return;
      }
      out.events.push({
        tx_hash: ctx.txHash,
        receipt_id: ro["id"] as string,
        log_index: idx,
        standard: parsed.standard,
        version: parsed.version,
        event: parsed.event,
        data: parsed.data,
        signer_id: ctx.signerId,
        block_height: ctx.blockHeight,
        block_time: ctx.blockTime,
      });
    });
  }
  return out;
}

/** The pseudo event that marks a state reset (`migrate` / `new`). Keyed by the tx hash (a tx has one reset). */
export function stateResetRow(tx: ListedTx, method: string): ChainEventRow {
  return {
    tx_hash: tx.hash,
    receipt_id: tx.hash,
    log_index: 0,
    standard: INDEX_STANDARD,
    version: "1",
    event: STATE_RESET_EVENT,
    data: { method },
    signer_id: tx.signerId,
    block_height: tx.blockHeight,
    block_time: nsToIso(tx.blockTimestamp),
  };
}

export function nsToIso(ns: string): string {
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
}

// ---------------------------------------------------------------------------------------------
// NearBlocks v3 listing
// ---------------------------------------------------------------------------------------------

export const NEARBLOCKS_TESTNET_BASE = "https://api-testnet.nearblocks.io";
export const NEARBLOCKS_PAGE_SIZE = 100;

export interface ListedTx {
  hash: string;
  signerId: string;
  receiverId: string;
  /** Block timestamp of the including block, nanoseconds, as text (it does not fit a JS number). */
  blockTimestamp: string;
  blockHeight: number;
  /** NearBlocks `outcomes.status`: `true` success, `false` failure, `null` unknown. */
  ok: boolean | null;
  actions: Array<{ action: string; method: string | null }>;
}

export interface ListPage {
  /** Newest first (NearBlocks v3 order). */
  txs: ListedTx[];
  /** Opaque cursor for the next (older) page; `null` on the last page. */
  next: string | null;
}

export class NearBlocksError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "NearBlocksError";
  }
}

/** `GET /v3/accounts/<account>/txns?limit=<n>[&next=<cursor>]` (v1/v2 are switched off on 2026-11-22, testnet is v3 only). */
export function nearBlocksTxnsUrl(base: string, accountId: string, limit: number, next: string | null): string {
  const u = new URL(`${base.replace(/\/+$/, "")}/v3/accounts/${encodeURIComponent(accountId)}/txns`);
  u.searchParams.set("limit", String(limit));
  if (next) u.searchParams.set("next", next);
  return u.toString();
}

const NS_TEXT = /^\d{15,22}$/;

function asNsText(v: unknown): string | null {
  const s = typeof v === "string" ? v : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : null;
  return s !== null && NS_TEXT.test(s) ? s : null;
}

/** Parse a v3 txns response body; throws `NearBlocksError` when the envelope is not recognisable. Malformed rows are dropped. */
export function parseNearBlocksPage(body: unknown): ListPage {
  if (!isRecord(body) || !Array.isArray(body["data"])) {
    const msg = isRecord(body) && Array.isArray(body["errors"]) ? JSON.stringify(body["errors"]).slice(0, 160) : "unexpected response shape";
    throw new NearBlocksError(`nearblocks: ${msg}`);
  }
  const txs: ListedTx[] = [];
  for (const item of body["data"]) {
    if (!isRecord(item)) continue;
    const hash = item["transaction_hash"];
    const signer = item["signer_account_id"];
    const receiver = item["receiver_account_id"];
    const ts = asNsText(item["block_timestamp"]);
    const block = isRecord(item["block"]) ? item["block"] : {};
    const height = Number(block["block_height"] ?? NaN);
    if (typeof hash !== "string" || typeof signer !== "string" || typeof receiver !== "string" || ts === null || !Number.isSafeInteger(height)) continue;
    const outcomes = isRecord(item["outcomes"]) ? item["outcomes"] : {};
    const actions = (Array.isArray(item["actions"]) ? item["actions"] : [])
      .filter(isRecord)
      .map((a) => ({ action: String(a["action"] ?? ""), method: typeof a["method"] === "string" ? a["method"] : null }));
    txs.push({
      hash,
      signerId: signer,
      receiverId: receiver,
      blockTimestamp: ts,
      blockHeight: height,
      ok: typeof outcomes["status"] === "boolean" ? outcomes["status"] : null,
      actions,
    });
  }
  const meta = isRecord(body["meta"]) ? body["meta"] : {};
  const next = typeof meta["next_page"] === "string" && meta["next_page"] !== "" ? meta["next_page"] : null;
  return { txs, next };
}

export type TxPlan =
  | { kind: "fetch" }
  | { kind: "reset"; method: string }
  | { kind: "skip"; reason: "failed" | "other_receiver" | "no_function_call" };

/**
 * What to do with a tx listed for `contractId` (the account whose listing it came from). Failed txs, txs to another receiver and
 * txs without a FunctionCall are never fetched (saves RPC calls). `resetsState` is true only for the Snacc contract:
 * its `migrate` / `new` wipe the strain state; the market's `new` does not.
 */
export function classifyTx(tx: ListedTx, contractId: string, resetsState = true): TxPlan {
  if (tx.ok === false) return { kind: "skip", reason: "failed" };
  if (tx.receiverId !== contractId) return { kind: "skip", reason: "other_receiver" };
  const calls = tx.actions.filter((a) => a.action === "FUNCTION_CALL");
  if (calls.length === 0) return { kind: "skip", reason: "no_function_call" };
  const reset = resetsState ? calls.find((a) => a.method !== null && STATE_RESET_METHODS.includes(a.method)) : undefined;
  if (reset && reset.method) return { kind: "reset", method: reset.method };
  return { kind: "fetch" };
}

// ---------------------------------------------------------------------------------------------
// Fetching one transaction outcome
// ---------------------------------------------------------------------------------------------

function isMissingTx(e: unknown): boolean {
  return e instanceof NearRpcError && e.kind === "rpc" && (e.causeName === "UNKNOWN_TRANSACTION" || e.causeName === "TIMEOUT_ERROR");
}

/**
 * `EXPERIMENTAL_tx_status` for a listed tx. Old txs go to the archival node first (regular nodes need ~10 s to answer
 * `TIMEOUT_ERROR / NOT_OBSERVED` for them); recent ones go to the regular nodes first and fall back to the archival node
 * when those do not know the tx. Throws when the answer is not the requested transaction.
 */
export async function fetchTxOutcome(rpc: NearRpc, tx: ListedTx, nowMs: number): Promise<unknown> {
  const params = { tx_hash: tx.hash, sender_account_id: tx.signerId, wait_until: "FINAL" };
  const archival = rpc.archivalUrl;
  const old = nowMs - Number(BigInt(tx.blockTimestamp) / 1_000_000n) > ARCHIVAL_AGE_MS;
  let result: unknown;
  if (old && archival) {
    try {
      result = await rpc.request<unknown>("EXPERIMENTAL_tx_status", params, [archival]);
    } catch {
      result = await rpc.request<unknown>("EXPERIMENTAL_tx_status", params);
    }
  } else {
    try {
      result = await rpc.request<unknown>("EXPERIMENTAL_tx_status", params);
    } catch (e) {
      if (!archival || !isMissingTx(e)) throw e;
      result = await rpc.request<unknown>("EXPERIMENTAL_tx_status", params, [archival]);
    }
  }
  const t = isRecord(result) && isRecord(result["transaction"]) ? result["transaction"] : null;
  if (!t || t["hash"] !== tx.hash) throw new NearRpcError("rpc", `tx_status: answer is not transaction ${tx.hash}`);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Cursor state and the batching loop
// ---------------------------------------------------------------------------------------------

export interface WalkState {
  /** Timestamp (ns, text) of the newest tx seen when this walk started; becomes `headTs` when the walk completes. */
  headTs: string;
  /** NearBlocks cursor of the page to (re)fetch; `null` = the newest page. */
  cursor: string | null;
  /** Inside that page, skip txs newer than this (already processed in an earlier run of the same walk). */
  resumeTs: string | null;
  /** Txs handled during this walk near its head (hash, ts); feeds `IndexState.seen` when the walk completes. */
  seen: Array<[string, string]>;
}

export interface RetryEntry {
  tx: ListedTx;
  attempts: number;
  lastError: string;
}

export interface IndexState {
  /** Every tx older than `headTs - LOOKBACK` has been handled (ns, text; "0" before the first walk). */
  headTs: string;
  /** (hash, ts) of handled txs within the lookback window below `headTs`; they are skipped when listed again. */
  seen: Array<[string, string]>;
  /** A walk interrupted by a budget (tx cap, page cap, deadline); `null` when the last walk completed. */
  walk: WalkState | null;
  /** Txs whose fetch/store failed; retried first on later runs. */
  retry: RetryEntry[];
  /** Txs given up after `MAX_RETRY_ATTEMPTS` (kept for audit, newest last). */
  dead: RetryEntry[];
}

export function emptyState(): IndexState {
  return { headTs: "0", seen: [], walk: null, retry: [], dead: [] };
}

export function cloneState(s: IndexState): IndexState {
  return JSON.parse(JSON.stringify(s)) as IndexState;
}

export interface IndexLimits {
  /** Max txs fetched from the RPC in one run (`SNACC_INDEX_MAX_TXS`). */
  maxTxs: number;
  /** Max NearBlocks pages listed in one run. */
  maxPages: number;
  /** Absolute epoch ms after which no new work is started. */
  deadlineMs: number;
}

export interface IndexCounts {
  pages: number;
  listed: number;
  fetched: number;
  resets: number;
  events: number;
  malformed: number;
  skipped: number;
  duplicates: number;
  errors: number;
  retried: number;
  dead: number;
  /** `true` when the run stopped on a budget before the walk was complete (call again to continue). */
  more: boolean;
}

export interface ProcessResult {
  events: number;
  malformed: number;
}

export interface IndexDeps {
  /** The account whose listing is walked (the Snacc contract, or the market contract). */
  contractId: string;
  /** `migrate` / `new` of this account reset the strain state (default `true`; `false` for the market). */
  resetsState?: boolean;
  /** Throws (`NearBlocksError`) when the listing cannot be read. */
  listPage(cursor: string | null): Promise<ListPage>;
  /** Fetch + store one tx (`plan.kind` is `fetch` or `reset`). Throws on any RPC or database problem. */
  processTx(tx: ListedTx, plan: Exclude<TxPlan, { kind: "skip" }>): Promise<ProcessResult>;
  nowMs(): number;
}

const big = (s: string): bigint => BigInt(s);

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 200);
}

function pruneSeen(seen: Array<[string, string]>, headTs: string): Array<[string, string]> {
  const floor = big(headTs) - LOOKBACK_NS;
  const map = new Map<string, string>();
  for (const [h, ts] of seen) if (big(ts) >= floor) map.set(h, ts);
  return [...map.entries()];
}

/**
 * One indexing run. Walks the listing newest to oldest (NearBlocks v3 only sorts descending), processing each tx not handled
 * before, until it reaches the stored head (minus the lookback window), the end of the listing, or a budget.
 *
 * Gap-free by construction: `headTs` only advances when a walk reaches the old head or the end of the listing. A budget stop
 * stores where to resume (`walk.cursor` + `walk.resumeTs`), and everything newer than the resume point is skipped next run.
 * Processing is idempotent (rows are upserted on receipt id + log index), so re-processing after a crash is harmless.
 * A failing tx goes to `retry` (it does not block the walk); after `MAX_RETRY_ATTEMPTS` it moves to `dead`.
 *
 * `deps.listPage` failures propagate: the caller must then NOT persist the returned state (cursor untouched).
 */
export async function runIndex(input: IndexState, deps: IndexDeps, limits: IndexLimits): Promise<{ state: IndexState; counts: IndexCounts }> {
  const state = cloneState(input);
  const counts: IndexCounts = { pages: 0, listed: 0, fetched: 0, resets: 0, events: 0, malformed: 0, skipped: 0, duplicates: 0, errors: 0, retried: 0, dead: 0, more: false };
  const budgetLeft = (): boolean => counts.fetched < limits.maxTxs && deps.nowMs() < limits.deadlineMs;

  const apply = async (tx: ListedTx, plan: Exclude<TxPlan, { kind: "skip" }>): Promise<ProcessResult> => {
    const r = await deps.processTx(tx, plan);
    if (plan.kind === "fetch") counts.fetched++;
    else counts.resets++;
    counts.events += r.events;
    counts.malformed += r.malformed;
    return r;
  };

  // 1. retries first
  const keep: RetryEntry[] = [];
  let tried = 0;
  for (const entry of state.retry) {
    const plan = classifyTx(entry.tx, deps.contractId, deps.resetsState !== false);
    if (plan.kind === "skip" || tried >= MAX_RETRIES_PER_RUN || !budgetLeft()) {
      if (plan.kind !== "skip") keep.push(entry);
      continue;
    }
    tried++;
    try {
      await apply(entry.tx, plan);
      counts.retried++;
    } catch (e) {
      const next = { ...entry, attempts: entry.attempts + 1, lastError: errText(e) };
      if (next.attempts >= MAX_RETRY_ATTEMPTS) {
        state.dead = [...state.dead, next].slice(-MAX_DEAD_ENTRIES);
        counts.dead++;
      } else keep.push(next);
      counts.errors++;
    }
  }
  state.retry = keep;

  // 2. walk the listing
  let walk = state.walk;
  const known = new Set([...state.seen, ...(walk ? walk.seen : [])].map(([h]) => h));
  const floor = big(state.headTs) - LOOKBACK_NS;
  for (;;) {
    if (counts.pages >= limits.maxPages || !budgetLeft()) {
      counts.more = true;
      break;
    }
    const cursor = walk ? walk.cursor : null;
    const page = await deps.listPage(cursor);
    counts.pages++;
    counts.listed += page.txs.length;
    const newest = page.txs[0];
    if (!walk) {
      if (!newest) break; // nothing listed at all
      walk = { headTs: newest.blockTimestamp, cursor: null, resumeTs: null, seen: [] };
    }
    let reachedFloor = false;
    let stoppedAt: ListedTx | null = null;
    for (const tx of page.txs) {
      const ts = big(tx.blockTimestamp);
      if (state.headTs !== "0" && ts < floor) {
        reachedFloor = true;
        break;
      }
      if (walk.resumeTs !== null && ts > big(walk.resumeTs)) continue; // done earlier in this walk
      if (known.has(tx.hash)) {
        counts.duplicates++;
        continue;
      }
      const plan = classifyTx(tx, deps.contractId, deps.resetsState !== false);
      if (plan.kind === "skip") {
        counts.skipped++;
        walk.seen.push([tx.hash, tx.blockTimestamp]);
        continue;
      }
      if (!budgetLeft()) {
        stoppedAt = tx;
        break;
      }
      try {
        await apply(tx, plan);
      } catch (e) {
        counts.errors++;
        state.retry.push({ tx, attempts: 1, lastError: errText(e) });
      }
      walk.seen.push([tx.hash, tx.blockTimestamp]);
    }
    if (stoppedAt) {
      walk.resumeTs = stoppedAt.blockTimestamp;
      counts.more = true;
      break;
    }
    if (reachedFloor || !page.next) {
      // walk complete: everything newer than the old head (minus lookback) has been handled
      state.headTs = walk.headTs;
      state.seen = pruneSeen([...state.seen, ...walk.seen], state.headTs);
      walk = null;
      break;
    }
    walk.cursor = page.next;
    walk.resumeTs = null;
  }
  state.walk = walk;
  if (walk) state.walk = { ...walk, seen: pruneSeen(walk.seen, walk.headTs) };
  return { state, counts };
}

/** Defensive read of the stored single row; anything unexpected falls back to a fresh state. */
export function normalizeState(row: Record<string, unknown> | null | undefined): IndexState {
  if (!row) return emptyState();
  const headTs = typeof row["head_ts"] === "string" && /^\d{1,22}$/.test(row["head_ts"]) ? row["head_ts"] : "0";
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const seen = arr<unknown>(row["seen"]).filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string" && NS_TEXT.test(x[1]));
  const w = row["walk"];
  let walk: WalkState | null = null;
  if (isRecord(w) && typeof w["headTs"] === "string" && NS_TEXT.test(w["headTs"])) {
    walk = {
      headTs: w["headTs"],
      cursor: typeof w["cursor"] === "string" ? w["cursor"] : null,
      resumeTs: typeof w["resumeTs"] === "string" && NS_TEXT.test(w["resumeTs"]) ? w["resumeTs"] : null,
      seen: arr<unknown>(w["seen"]).filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === "string" && typeof x[1] === "string" && NS_TEXT.test(x[1])),
    };
  }
  const entries = (v: unknown): RetryEntry[] =>
    arr<unknown>(v).filter(
      (x): x is RetryEntry => isRecord(x) && isRecord(x["tx"]) && typeof (x["tx"] as Record<string, unknown>)["hash"] === "string" && typeof x["attempts"] === "number",
    );
  return { headTs, seen, walk, retry: entries(row["retry"]), dead: entries(row["dead"]) };
}
