/**
 * Server bootstrap (INT-101). Env: PORT, CONTRACT_ID, RPC_URLS (or legacy RPC_URL), POLL_INTERVAL_MS,
 * VIEW_CACHE_TTL_MS / VIEW_STALE_TTL_MS / RPC_COOLDOWN_BASE_MS, NEAR_AI_API_KEY (optional, VC-015).
 * Without env -> defaults to testnet + dictionary contract snacc-v001.testnet.
 */

import { createServer } from "node:http";
import { NearRpcClient } from "./near.js";
import { route, newStore, corsHeaders } from "./server.js";
import { pollTick, newPollerState } from "./poller.js";
import { newEvaluateState, type EvaluateDeps } from "./evaluate.js";

const PORT = Number(process.env["PORT"] ?? 8787);
const CONTRACT_ID = process.env["CONTRACT_ID"] ?? "snacc-v001.testnet";
// Public testnet RPCs rate-limit per source IP, so a single endpoint is not enough:
// `rpc.testnet.near.org` mostly answers 429 from cloud IPs, `near-testnet.lava.build` is gone
// (HTTP 410) and `rpc.testnet.pagoda.co` requires auth (403). The client rotates a LIST of
// endpoints (INT-104): `RPC_URLS` (comma-separated), with `RPC_URL` kept as a legacy fallback.
// Defaults are the public testnet endpoints from the official NEAR docs provider list
// (docs.near.org/api/rpc/providers): dRPC first (it carries the manual override in
// production), then FastNear, then Intear; near.org last — officially deprecated and
// severely rate-limited, kept only as a last resort.
const RPC_URLS = (
  process.env["RPC_URLS"] ??
    process.env["RPC_URL"] ??
    "https://near-testnet.drpc.org,https://test.rpc.fastnear.com,https://testnet-rpc.intea.rs,https://rpc.testnet.near.org"
)
  .split(",")
  .map((u) => u.trim())
  .filter((u) => u.length > 0);
const POLL_INTERVAL_MS = Number(process.env["POLL_INTERVAL_MS"] ?? 15000);
// RPC pool tuning: view cache TTL (fresh), stale-if-error window, 429 cooldown base.
const VIEW_CACHE_TTL_MS = Number(process.env["VIEW_CACHE_TTL_MS"] ?? 10_000);
const VIEW_STALE_TTL_MS = Number(process.env["VIEW_STALE_TTL_MS"] ?? 120_000);
const RPC_COOLDOWN_BASE_MS = Number(process.env["RPC_COOLDOWN_BASE_MS"] ?? 60_000);

const rpc = new NearRpcClient(RPC_URLS, fetch, 400, 10000, {
  viewCacheTtlMs: VIEW_CACHE_TTL_MS,
  viewStaleTtlMs: VIEW_STALE_TTL_MS,
  cooldownBaseMs: RPC_COOLDOWN_BASE_MS,
});
const store = newStore();
const pollerState = newPollerState();
// VC-015: NEAR AI key comes strictly from server env; never logged or returned. Empty -> 503 tee_not_configured.
const evaluateDeps: EvaluateDeps = { apiKey: process.env["NEAR_AI_API_KEY"] || undefined, ...newEvaluateState() };

const server = createServer((req, res) => {
  route(req, { rpc, contractId: CONTRACT_ID, store, evaluate: evaluateDeps, poller: pollerState })
    .then((r) => {
      res.writeHead(r.status, {
        "Content-Type": r.contentType ?? "application/json",
        ...corsHeaders(req.method),
        ...r.headers,
      });
      res.end(r.contentType ? r.body : JSON.stringify(r.body));
    })
    .catch((err: unknown) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal_error", message: String(err) }));
    });
});

server.listen(PORT, () => {
  console.log(`snacc-backend listening on :${PORT}, contract=${CONTRACT_ID}, rpc=${RPC_URLS.join(",")}`);
});

// Event poller v2 (INT-102/INT-104): discovery via the NearBlocks v3 account feed (1 call per
// tick, no key, 10 s abort timeout), event logs via the NEAR `tx` RPC per new contract tx
// (budget 5/tick, 10 s client timeout), and a global exponential backoff on 429/5xx (backing-off
// ticks make NO API calls, so the other view endpoints keep their RPC budget). The loop is a
// chained setTimeout (never overlapping): the next tick is scheduled only after the current one
// settles, and a tick that hangs is cut off by the pollTick watchdog and recorded as a failure.
// Lag is logged every tick and exposed on /api/events as the `x-indexer-lag-blocks` response
// header (no new body field — the spec does not define one).
const DISCOVERY_TIMEOUT_MS = 10000;
const discoveryFetch = (async (url: string) => {
  // The abort signal covers the fetch AND the body read (the body is pre-read and cached),
  // so a hanging NearBlocks response can never stall the poll loop.
  const res = await fetch(url, { signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS) });
  // Non-OK bodies (e.g. a 429 HTML page) are not parsed, so the HTTP status reaches pollOnce.
  const body = res.ok ? await res.json() : null;
  return { ok: res.ok, status: res.status, json: async () => body };
}) as import("./poller.js").DiscoveryFetch;

let stopped = false;
let inFlight = 0;
let timer: ReturnType<typeof setTimeout>;
async function tick(): Promise<void> {
  if (stopped) return;
  if (inFlight > 0) {
    // A previous tick (or its in-flight pollOnce) has not settled — never overlap.
    console.warn("poller: previous tick still in flight — skipping this tick");
  } else {
    inFlight += 1;
    try {
      await pollTick(rpc, discoveryFetch, CONTRACT_ID, store, pollerState);
      console.log(
        `poller: head=${pollerState.headHeight} cursor=${pollerState.cursorHeight} lag=${pollerState.lagBlocks} events=${store.events.length} dropped=${store.droppedEvents} queue=${pollerState.queue.length} 429s=${pollerState.rateLimitedErrors} backoffTicks=${pollerState.backedOffTicks}`,
      );
    } catch (err) {
      console.error("poller:", String(err));
    } finally {
      inFlight -= 1;
    }
  }
  if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
}
timer = setTimeout(tick, POLL_INTERVAL_MS);

function shutdown(): void {
  stopped = true;
  clearTimeout(timer);
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
