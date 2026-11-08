/**
 * Router HTTP /api/* (INT-101..103, VC-020, INT-105..106, VC-015). Node murni, tanpa framework.
 * Semua data dari view kontrak / enclave NEAR AI Cloud; endpoint yang sumber datanya belum ada
 * merespons 501 + ID backlog — tidak pernah mengarang data. `POST /api/tee/evaluate-genome` (VC-015)
 * dipagari kunci server + tanda tangan NEP-413 pemilik strain + rate limit (lihat evaluate.ts).
 */

import { IncomingMessage } from "node:http";
import { NearRpcClient, RpcError } from "./near.js";
import { fetchMacroState, fetchStrain } from "./macro.js";
import { EventStore, newEventStore } from "./events.js";
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
  /** Injeksi untuk test; default `fetch` global. Dipakai route `/api/tee/attestation-report`. */
  fetchFn?: FetchLike;
  /** Pagar `POST /api/tee/evaluate-genome` (VC-015); tanpa ini endpoint 503 `tee_not_configured`. */
  evaluate?: EvaluateDeps;
}

export interface RouterResult {
  status: number;
  body: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

/** Baca body JSON ≤ `max` byte dari stream request; `null` bila terlalu besar, `undefined` bila bukan JSON. */
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

/** Hasil view `{error}` -> status HTTP. */
function statusOfError(error: string): number {
  if (error === "strain_not_found") return 404;
  if (error === "svg_media_unavailable") return 502;
  return 503;
}

function intParam(v: string | null): number | undefined {
  if (v === null || !/^\d{1,15}$/.test(v)) return undefined;
  return Number(v);
}

/** RPC hulu gagal (429 habis retry, 5xx, dll.) -> 503 jujur, bukan 500 internal. */
export async function route(req: IncomingMessage, deps: RouterDeps): Promise<RouterResult> {
  try {
    return await routeInner(req, deps);
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

  // `/api/crucible/strains[...]` = alias spec (Spec API Backend §2).
  const p = pathname.replace(/^\/api\/crucible\/strains/, "/api/strains");

  if (p === "/api/strains") {
    const list = await fetchStrainList(rpc, contractId);
    if ("error" in list) return { status: 503, body: list };
    // `indexer_incomplete` tetap ada demi kompatibilitas: daftar kini dari view kontrak, bukan event.
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
      // SVG dari kontrak diperlakukan sebagai gambar pasif: tanpa script/fetch bila dibuka langsung.
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
      // percent-encoding rusak -> ditolak validasi di bawah
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
    const zoneEvents = deps.store.events
      .filter((e) => e.kind === "zone_changed")
      .map((e) => e.raw);
    const out = await fetchZones(rpc, contractId, zoneEvents);
    if ("error" in out) return { status: 503, body: out };
    return { status: 200, body: out };
  }

  if (pathname === "/api/tee/attestation-report") {
    const out = await fetchAttestation(deps.fetchFn ?? fetch);
    if ("error" in out) return { status: 502, body: out };
    return { status: 200, body: out };
  }

  if (pathname === "/api/events") {
    return {
      status: 200,
      body: {
        events: deps.store.events,
        indexer_incomplete: !deps.store.indexerComplete,
        contractId,
      },
    };
  }

  if (pathname === "/api/tee/evaluate-genome") {
    if (req.method !== "POST") {
      return { status: 405, body: { error: "method_not_allowed" }, headers: { Allow: "POST" } };
    }
    // Tanpa kunci server: tolak dulu, sebelum membaca body atau memanggil RPC.
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
