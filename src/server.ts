/**
 * Router HTTP /api/crucible/* (INT-101..103). Node murni, tanpa framework.
 * Endpoint stub merespons 501 + ID backlog — tidak pernah mengarang data.
 */

import { IncomingMessage, ServerResponse } from "node:http";
import { NearRpcClient } from "./near.js";
import { fetchMacroState, fetchStrain } from "./macro.js";
import { EventStore, newEventStore } from "./events.js";

export interface RouterDeps {
  rpc: NearRpcClient;
  contractId: string;
  store: EventStore;
}

export interface RouterResult {
  status: number;
  body: unknown;
  contentType?: string;
}

const STUBS: Record<string, string> = {
  "/api/strains/:id/svg": "VC-020 (SVG proxy)",
  "/api/colony/:owner": "INT-105..106 (koloni EN-08)",
  "/api/dividends": "INT-105..106 (dividen DK-033)",
  "/api/zones": "INT-105..106 (riwayat zone_changed)",
  "/api/appetite": "INT-105..106 (appetite meter EN-05)",
  "/api/tee/evaluate-genome": "TEE protocol (oracle-tee M3)",
  "/api/tee/attestation-report": "TEE protocol (oracle-tee M3)",
};

function matchStub(pathname: string): string | undefined {
  for (const pattern of Object.keys(STUBS)) {
    const patParts = pattern.split("/");
    const pathParts = pathname.split("/");
    if (patParts.length !== pathParts.length) continue;
    let ok = true;
    for (let i = 0; i < patParts.length; i++) {
      const pat = patParts[i];
      const seg = pathParts[i];
      if (pat === undefined || seg === undefined || (pat !== seg && !pat.startsWith(":"))) {
        ok = false;
        break;
      }
    }
    if (ok) return STUBS[pattern];
  }
  return undefined;
}

export async function route(req: IncomingMessage, deps: RouterDeps): Promise<RouterResult> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  if (pathname === "/api/crucible/macro") {
    const macro = await fetchMacroState(deps.rpc, deps.contractId);
    if ("error" in macro) return { status: 503, body: macro };
    return { status: 200, body: macro };
  }

  if (pathname === "/api/strains") {
    return {
      status: 200,
      body: {
        strains: [...deps.store.strainsSeen.entries()].map(([id, v]) => ({
          strain_id: id,
          owner_id: v.owner_id,
        })),
        indexer_incomplete: !deps.store.indexerComplete,
        contractId: deps.contractId,
      },
    };
  }

  const strainMatch = pathname.match(/^\/api\/strains\/(\d+)$/);
  if (strainMatch) {
    const idRaw = strainMatch[1];
    if (idRaw === undefined) return { status: 404, body: { error: "not_found", path: pathname } };
    const strain = await fetchStrain(deps.rpc, deps.contractId, Number(idRaw));
    if ("error" in strain) {
      return { status: strain.error === "strain_not_found" ? 404 : 503, body: strain };
    }
    return { status: 200, body: strain };
  }

  if (pathname === "/api/events") {
    return {
      status: 200,
      body: {
        events: deps.store.events,
        indexer_incomplete: !deps.store.indexerComplete,
        contractId: deps.contractId,
      },
    };
  }

  const stubTodo = matchStub(pathname);
  if (stubTodo) {
    return { status: 501, body: { error: "not_implemented", todo: stubTodo } };
  }

  return { status: 404, body: { error: "not_found", path: pathname } };
}

export function newStore(): EventStore {
  return newEventStore();
}
