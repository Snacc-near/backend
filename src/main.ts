/**
 * Server bootstrap (INT-101). Env: PORT, CONTRACT_ID, RPC_URL, POLL_INTERVAL_MS, NEAR_AI_API_KEY (optional, VC-015).
 * Without env -> defaults to testnet + dictionary contract snacc-v001.testnet.
 */

import { createServer } from "node:http";
import { NearRpcClient } from "./near.js";
import { route, newStore } from "./server.js";
import { collectEventsFromChunk, absorbEvent } from "./events.js";
import { newEvaluateState, type EvaluateDeps } from "./evaluate.js";

const PORT = Number(process.env["PORT"] ?? 8787);
const CONTRACT_ID = process.env["CONTRACT_ID"] ?? "snacc-v001.testnet";
const RPC_URL = process.env["RPC_URL"] ?? "https://test.rpc.fastnear.com"; // rpc.testnet.near.org deprecated (HTTP 429)
const POLL_INTERVAL_MS = Number(process.env["POLL_INTERVAL_MS"] ?? 15000);

const rpc = new NearRpcClient(RPC_URL);
const store = newStore();
// VC-015: NEAR AI key comes strictly from server env; never logged or returned. Empty -> 503 tee_not_configured.
const evaluateDeps: EvaluateDeps = { apiKey: process.env["NEAR_AI_API_KEY"] || undefined, ...newEvaluateState() };

const server = createServer((req, res) => {
  route(req, { rpc, contractId: CONTRACT_ID, store, evaluate: evaluateDeps })
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

// Simple poller: fetch the latest chunks from the latest final block (INT-104; full
// per-block-range indexer is deferred to INT-102 follow-up — see README note).
const timer = setInterval(async () => {
  try {
    const block = await rpc.fetchJsonRpc<{ header: { chunk_ids: string[] } }>("block", {
      finality: "final",
    });
    for (const chunkId of block.header.chunk_ids) {
      const chunk = await rpc.chunk(chunkId);
      for (const ev of collectEventsFromChunk(chunk)) absorbEvent(store, ev);
    }
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
