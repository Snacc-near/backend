/**
 * Server bootstrap (INT-101). Env: PORT, CONTRACT_ID, RPC_URL, POLL_INTERVAL_MS, NEAR_AI_API_KEY (optional, VC-015).
 * Without env -> defaults to testnet + dictionary contract snacc-v001.testnet.
 */

import { createServer } from "node:http";
import { NearRpcClient } from "./near.js";
import { route, newStore } from "./server.js";
import { pollOnce, newPollerState, indexerLagBlocks } from "./poller.js";
import { newEvaluateState, type EvaluateDeps } from "./evaluate.js";

const PORT = Number(process.env["PORT"] ?? 8787);
const CONTRACT_ID = process.env["CONTRACT_ID"] ?? "snacc-v001.testnet";
const RPC_URL = process.env["RPC_URL"] ?? "https://test.rpc.fastnear.com"; // rpc.testnet.near.org deprecated (HTTP 429)
const POLL_INTERVAL_MS = Number(process.env["POLL_INTERVAL_MS"] ?? 15000);

const rpc = new NearRpcClient(RPC_URL);
const store = newStore();
const pollerState = newPollerState();
// VC-015: NEAR AI key comes strictly from server env; never logged or returned. Empty -> 503 tee_not_configured.
const evaluateDeps: EvaluateDeps = { apiKey: process.env["NEAR_AI_API_KEY"] || undefined, ...newEvaluateState() };

const server = createServer((req, res) => {
  route(req, { rpc, contractId: CONTRACT_ID, store, evaluate: evaluateDeps, poller: pollerState })
    .then((r) => {
      res.writeHead(r.status, {
        "Content-Type": r.contentType ?? "application/json",
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
  console.log(`snacc-backend listening on :${PORT}, contract=${CONTRACT_ID}, rpc=${RPC_URL}`);
});

// Event poller (INT-102/INT-104): block → chunks → receipt logs via the public RPC, with a
// per-block cursor, catch-up bounded per tick, 429 backoff in NearRpcClient, and a bounded
// in-memory store. Path E of docs/indexer-decision.md. Lag is logged every tick and exposed
// on /api/events as the `x-indexer-lag-blocks` response header (no new body field — the spec
// does not define one).
const timer = setInterval(async () => {
  try {
    await pollOnce(rpc, CONTRACT_ID, store, pollerState);
    const lag = indexerLagBlocks(pollerState);
    console.log(
      `poller: head=${pollerState.headHeight} cursor=${pollerState.cursorHeight} lag=${lag} events=${store.events.length} dropped=${store.droppedEvents}`,
    );
  } catch (err) {
    console.error("poller:", String(err));
  }
}, POLL_INTERVAL_MS);

function shutdown(): void {
  clearInterval(timer);
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
