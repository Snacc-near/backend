// chain-index (deploy with verify_jwt = false; requires header x-cron-secret = Vault secret snacc_cron_secret)
// Lists the transactions to the Snacc contract (and to the market contract snacc-market.testnet) with the NearBlocks API v3
// (newest first), fetches each outcome with EXPERIMENTAL_tx_status, and stores every NEP-297 EVENT_JSON log of a successful
// receipt in chain_events_snacc (UI-155 lineage + history, UI-156 graveyard are SQL views over that table).
// One cursor row per indexed account lives in chain_index_state_snacc. At most SNACC_INDEX_MAX_TXS txs per account per run
// (default 50), no new work after ~50 s; call again to continue a backlog.
import { fail, ok, safeEqual, toResponse } from "../_shared/http.ts";
import { NearRpc, resolveContractId } from "../_shared/near-rpc.ts";
import {
  NEARBLOCKS_PAGE_SIZE,
  NEARBLOCKS_TESTNET_BASE,
  NearBlocksError,
  extractEvents,
  fetchTxOutcome,
  nearBlocksTxnsUrl,
  normalizeState,
  nsToIso,
  parseNearBlocksPage,
  resolveMarketId,
  runIndex,
  stateResetRow,
  type ChainEventRow,
  type EventSources,
  type IndexCounts,
  type IndexDeps,
  type IndexState,
  type ListPage,
} from "../_shared/chain-index.ts";
import { env, guarded, serviceClient } from "../_deno/db.ts";

const sb = serviceClient();
const rpc = new NearRpc();
const contractId = resolveContractId(env);
const marketId = resolveMarketId(env);
const sources: EventSources = { snacc: contractId, market: marketId };

/** Stop starting new work after this long so the run ends inside the Edge wall-clock limit. */
const TIME_BUDGET_MS = 50_000;

function intEnv(name: string, def: number, max: number): number {
  const n = Number(env(name) ?? def);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : def;
}

/** NearBlocks v3 page; any transport/HTTP/shape problem becomes a NearBlocksError (that account's cursor stays untouched). */
async function listPage(accountId: string, cursor: string | null): Promise<ListPage> {
  const headers: Record<string, string> = { accept: "application/json" };
  const key = env("NEARBLOCKS_API_KEY");
  if (key) headers["authorization"] = `Bearer ${key}`;
  let res: Response;
  try {
    res = await fetch(nearBlocksTxnsUrl(NEARBLOCKS_TESTNET_BASE, accountId, NEARBLOCKS_PAGE_SIZE, cursor), { headers, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new NearBlocksError(`nearblocks: ${e instanceof Error ? e.message.slice(0, 120) : "network error"}`);
  }
  if (!res.ok) throw new NearBlocksError(`nearblocks: HTTP ${res.status}`, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new NearBlocksError("nearblocks: non-JSON body", res.status);
  }
  return parseNearBlocksPage(body);
}

async function store(rows: ChainEventRow[]): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await sb.from("chain_events_snacc").upsert(rows, { onConflict: "receipt_id,log_index", ignoreDuplicates: true });
  if (error) throw new Error(`chain_events_snacc: ${error.message}`);
}

function depsFor(accountId: string, resetsState: boolean): IndexDeps {
  return {
    contractId: accountId,
    resetsState,
    listPage: (cursor) => listPage(accountId, cursor),
    nowMs: () => Date.now(),
    async processTx(tx, plan) {
      if (plan.kind === "reset") {
        await store([stateResetRow(tx, plan.method)]);
        return { events: 0, malformed: 0 };
      }
      const result = await fetchTxOutcome(rpc, tx, Date.now());
      const extracted = extractEvents(result, { txHash: tx.hash, signerId: tx.signerId, blockHeight: tx.blockHeight, blockTime: nsToIso(tx.blockTimestamp) }, sources);
      await store(extracted.events);
      return { events: extracted.events.length, malformed: extracted.malformed };
    },
  };
}

async function loadState(accountId: string): Promise<IndexState> {
  const { data, error } = await sb.from("chain_index_state_snacc").select("head_ts, seen, walk, retry, dead").eq("account_id", accountId).maybeSingle();
  if (error) throw new Error(`chain_index_state_snacc: ${error.message}`);
  return normalizeState(data as Record<string, unknown> | null);
}

async function saveState(accountId: string, state: IndexState, counts: Record<string, unknown>): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await sb.from("chain_index_state_snacc").upsert(
    { account_id: accountId, head_ts: state.headTs, seen: state.seen, walk: state.walk, retry: state.retry, dead: state.dead, last_counts: counts, last_run_at: now, updated_at: now },
    { onConflict: "account_id" },
  );
  if (error) throw new Error(`chain_index_state_snacc: ${error.message}`);
}

const SUMMED: Array<keyof IndexCounts> = ["pages", "listed", "fetched", "resets", "events", "malformed", "skipped", "duplicates", "errors", "retried", "dead"];

async function indexRun() {
  const started = Date.now();
  const accounts: Array<{ id: string; resetsState: boolean }> = [{ id: contractId, resetsState: true }];
  if (marketId && marketId !== contractId) accounts.push({ id: marketId, resetsState: false });
  const totals: Record<string, number> = Object.fromEntries(SUMMED.map((k) => [k, 0]));
  const perAccount: Record<string, Record<string, unknown>> = {};
  let more = false;
  let retryQueue = 0;
  let deadTotal = 0;
  const unavailable: string[] = [];
  for (const account of accounts) {
    const state = await loadState(account.id);
    try {
      const { state: next, counts } = await runIndex(state, depsFor(account.id, account.resetsState), {
        maxTxs: intEnv("SNACC_INDEX_MAX_TXS", 50, 500),
        maxPages: intEnv("SNACC_INDEX_MAX_PAGES", 3, 20),
        deadlineMs: started + TIME_BUDGET_MS,
      });
      const summary = { ...counts, retryQueue: next.retry.length, deadTotal: next.dead.length };
      await saveState(account.id, next, summary);
      perAccount[account.id] = summary;
      for (const k of SUMMED) totals[k] = (totals[k] ?? 0) + Number(counts[k]);
      more = more || counts.more;
      retryQueue += next.retry.length;
      deadTotal += next.dead.length;
    } catch (e) {
      if (!(e instanceof NearBlocksError)) throw e;
      // Cursor untouched: the next scheduled run simply tries again.
      console.error("chain-index: NearBlocks unavailable for", account.id, e.message);
      unavailable.push(account.id);
    }
  }
  const summary = { ...totals, more, retryQueue, deadTotal, accounts: perAccount };
  console.log(JSON.stringify({ fn: "chain-index", ms: Date.now() - started, ...summary, unavailable }));
  if (unavailable.length > 0) {
    return fail(503, "index_unavailable", "NearBlocks listing is unavailable; the cursor of the affected account was not changed.", { ...summary, unavailable });
  }
  return ok(summary);
}

/**
 * The cron secret lives in Supabase Vault (migration 20261113000005), exactly as for notify-scan. An explicit
 * SNACC_CRON_SECRET edge secret still wins when set.
 */
async function cronSecretCheck(got: string): Promise<"ok" | "bad" | "unavailable"> {
  if (!got) return "bad";
  const secret = env("SNACC_CRON_SECRET");
  if (secret) return safeEqual(got, secret) ? "ok" : "bad";
  const { data, error } = await sb.rpc("snacc_cron_secret_ok", { candidate: got });
  if (error) {
    console.error("chain-index: snacc_cron_secret_ok failed", error.message);
    return "unavailable";
  }
  return data === true ? "ok" : "bad";
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return toResponse(fail(405, "method_not_allowed", "Use POST."), null, false);
  const check = await cronSecretCheck(req.headers.get("x-cron-secret") ?? "");
  if (check === "unavailable") {
    return toResponse(fail(503, "not_configured", "Cron secret check is unavailable (Vault function missing)."), null, false);
  }
  if (check === "bad") {
    return toResponse(fail(401, "unauthorized", "Missing or wrong x-cron-secret."), null, false);
  }
  return guarded("chain-index", null, indexRun, false);
});
