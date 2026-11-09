/**
 * HTTP router /api/* (INT-101..103, VC-020, INT-105..106, VC-015). Pure Node, no framework.
 * All data comes from contract views / NEAR AI Cloud enclave; endpoints whose data source does not yet exist
 * respond 501 + backlog ID — never fabricating data. `POST /api/tee/evaluate-genome` (VC-015)
 * is gated by the server key + strain owner NEP-413 signature + rate limit (see evaluate.ts).
 */

import { IncomingMessage } from "node:http";
import { NearRpcClient, RpcError } from "./near.js";
import { fetchMacroState, fetchStrain } from "./macro.js";
import { EventStore, newEventStore } from "./events.js";
import { type PollerState } from "./poller.js";
import {
  fetchAppetite,
  fetchColony,
  fetchDividends,
  fetchStrainList,
  fetchStrainSvg,
  fetchZones,
  isValidAccountId,
} from "./views.js";
import { fetchAttestation, type FetchLike } from "./tee.js";
import { MAX_BODY_BYTES, evaluateGenome, type EvaluateDeps } from "./evaluate.js";

export interface RouterDeps {
  rpc: NearRpcClient;
  contractId: string;
  store: EventStore;
  /** Injection hook for tests; defaults to global `fetch`. Used by route `/api/tee/attestation-report`. */
  fetchFn?: FetchLike;
  /** Gate for `POST /api/tee/evaluate-genome` (VC-015); without this, the endpoint returns 503 `tee_not_configured`. */
  evaluate?: EvaluateDeps;
  /** Poller cursor state (INT-102); when absent, /api/events reports the store as-is (indexer_incomplete). */
  poller?: PollerState;
}

export interface RouterResult {
  status: number;
  body: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

/** Read a JSON body ≤ `max` bytes from the request stream; returns `null` if too large, `undefined` if invalid JSON. */
async function readJsonBody(req: IncomingMessage, max: number): Promise<unknown | null | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > max) return null;
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Map view `{error}` result -> HTTP status code. */
function statusOfError(error: string): number {
  if (error === "strain_not_found") return 404;
  if (error === "svg_media_unavailable") return 502;
  return 503;
}

function intParam(v: string | null): number | undefined {
  if (v === null || !/^\d{1,15}$/.test(v)) return undefined;
  return Number(v);
}

/** Upstream RPC failure (429 exhausted retries, 5xx, etc.) -> honest 503, not internal 500. */
/**
 * CORS for the public read-only API (UI-117..126 frontend is hosted on another origin): GET/HEAD
 * responses carry `Access-Control-Allow-Origin: *` (and expose the indexer lag header). Other
 * methods get no CORS headers, so `POST /api/tee/evaluate-genome` stays non-callable from browsers
 * on other origins (no preflight is answered).
 */
export function corsHeaders(method: string | undefined): Record<string, string> {
  if (method !== "GET" && method !== "HEAD") return {};
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "x-indexer-lag-blocks, x-data-stale-seconds",
  };
}

/**
 * When a view was served stale from the cache (every RPC endpoint failing), the response
 * carries `x-data-stale-seconds` so consumers know the data's age — the data itself is never
 * fabricated, only labelled.
 */
export function staleHeaderFor(body: unknown): Record<string, string> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const s = (body as Record<string, unknown>)["staleSeconds"];
    if (typeof s === "number" && Number.isFinite(s) && s >= 0) {
      return { "x-data-stale-seconds": String(Math.floor(s)) };
    }
  }
  return {};
}

export async function route(req: IncomingMessage, deps: RouterDeps): Promise<RouterResult> {
  try {
    const result = await routeInner(req, deps);
    return { ...result, headers: { ...staleHeaderFor(result.body), ...result.headers } };
  } catch (err) {
    if (err instanceof RpcError) {
      return { status: 503, body: { error: "rpc_unavailable", message: err.message } };
    }
    throw err;
  }
}

async function routeInner(req: IncomingMessage, deps: RouterDeps): Promise<RouterResult> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const { rpc, contractId } = deps;

  if (pathname === "/api/crucible/macro") {
    const macro = await fetchMacroState(rpc, contractId);
    if ("error" in macro) return { status: 503, body: macro };
    return { status: 200, body: macro };
  }

  // `/api/crucible/strains[...]` = spec alias (Backend API Spec §2).
  const p = pathname.replace(/^\/api\/crucible\/strains/, "/api/strains");

  if (p === "/api/strains") {
    const list = await fetchStrainList(rpc, contractId);
    if ("error" in list) return { status: 503, body: list };
    // `indexer_incomplete` is retained for backwards compatibility: the list now comes from contract views, not events.
    return { status: 200, body: { ...list, indexer_incomplete: false } };
  }

  const svgMatch = p.match(/^\/api\/strains\/(\d+)\/svg$/);
  if (svgMatch) {
    const out = await fetchStrainSvg(rpc, contractId, Number(svgMatch[1]));
    if ("error" in out) return { status: statusOfError(out.error), body: out };
    return {
      status: 200,
      body: out.svg,
      contentType: "image/svg+xml; charset=utf-8",
      // Contract-supplied SVG is treated as a passive image: no script/fetch execution if opened directly.
      headers: { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" },
    };
  }

  const strainMatch = p.match(/^\/api\/strains\/(\d+)$/);
  if (strainMatch) {
    const idRaw = strainMatch[1];
    if (idRaw === undefined) return { status: 404, body: { error: "not_found", path: pathname } };
    const strain = await fetchStrain(rpc, contractId, Number(idRaw));
    if ("error" in strain) return { status: statusOfError(strain.error), body: strain };
    return { status: 200, body: strain };
  }

  const colonyMatch = pathname.match(/^\/api\/colony\/([^/]+)$/);
  if (colonyMatch) {
    let owner = colonyMatch[1] ?? "";
    try {
      owner = decodeURIComponent(owner);
    } catch {
      // malformed percent-encoding -> rejected by validation below
    }
    if (!isValidAccountId(owner)) {
      return { status: 400, body: { error: "invalid_account_id", owner_id: owner } };
    }
    const colony = await fetchColony(rpc, contractId, owner);
    if ("error" in colony) return { status: 503, body: colony };
    return { status: 200, body: colony };
  }

  if (pathname === "/api/dividends") {
    const epoch = intParam(url.searchParams.get("epoch"));
    const strainId = intParam(url.searchParams.get("strain_id"));
    if ((epoch === undefined) !== (strainId === undefined)) {
      return { status: 400, body: { error: "epoch_and_strain_id_required_together" } };
    }
    const out = await fetchDividends(
      rpc,
      contractId,
      epoch !== undefined && strainId !== undefined ? { epoch, strain_id: strainId } : undefined,
    );
    if ("error" in out) return { status: 503, body: out };
    return { status: 200, body: out };
  }

  if (pathname === "/api/appetite") {
    const out = await fetchAppetite(rpc, contractId);
    if ("error" in out) return { status: 503, body: out };
    return { status: 200, body: out };
  }

  if (pathname === "/api/zones") {
    const zoneEvents = deps.store.events.filter((e) => e.kind === "zone_changed");
    const out = await fetchZones(rpc, contractId, zoneEvents, deps.store.indexerComplete);
    if ("error" in out) return { status: 503, body: out };
    const lag = deps.poller?.lagBlocks ?? null;
    return {
      status: 200,
      body: out,
      headers: lag === null ? undefined : { "x-indexer-lag-blocks": String(lag) },
    };
  }

  if (pathname === "/api/tee/attestation-report") {
    const out = await fetchAttestation(deps.fetchFn ?? fetch);
    if ("error" in out) return { status: 502, body: out };
    return { status: 200, body: out };
  }

  if (pathname === "/api/events") {
    // The spec does not define a lag body field, so the lag goes in a response header only.
    // Meaning (poller v2): chain head − the block of the newest contract tx absorbed;
    // it grows when the contract is quiet (no recent activity) — the health signal is
    // `indexer_incomplete`, which is true while the discovery source fails/backing off
    // or the backfill queue is not drained.
    const lag = deps.poller?.lagBlocks ?? null;
    return {
      status: 200,
      body: {
        events: deps.store.events,
        indexer_incomplete: !deps.store.indexerComplete,
        contractId,
      },
      headers: lag === null ? undefined : { "x-indexer-lag-blocks": String(lag) },
    };
  }

  if (pathname === "/api/tee/evaluate-genome") {
    if (req.method !== "POST") {
      return { status: 405, body: { error: "method_not_allowed" }, headers: { Allow: "POST" } };
    }
    // Without server key: reject immediately before reading body or calling RPC.
    if (!deps.evaluate?.apiKey) return { status: 503, body: { error: "tee_not_configured" } };
    const body = await readJsonBody(req, MAX_BODY_BYTES);
    if (body === null) return { status: 413, body: { error: "body_too_large", maxBytes: MAX_BODY_BYTES } };
    if (body === undefined) return { status: 400, body: { error: "invalid_json" } };
    return evaluateGenome(body, rpc, contractId, deps.evaluate);
  }

  return { status: 404, body: { error: "not_found", path: pathname } };
}

export function newStore(): EventStore {
  return newEventStore();
}
