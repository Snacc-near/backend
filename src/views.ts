/**
 * Contract view -> read-only route mapping (VC-020, INT-105..106).
 * All data comes from contract views (`snacc-v001.*`) via RPC; field names are copied verbatim
 * from `contracts/snacc/src/{lib,state}.rs`. No numbers are fabricated or recomputed.
 */

import {
  NearRpcClient,
  ViewPanicError,
  isContractNotDeployed,
  quoteU128Fields,
} from "./near.js";
import { STRAIN_U128_FIELDS, type StrainVesselView } from "./macro.js";
import type { CrucibleEvent } from "./events.js";

export type NotDeployed = { error: "contract_not_deployed" };

/** Maximum strains enumerated per request (protects public RPC load). */
export const MAX_STRAINS_LISTED = 200;
const FETCH_CONCURRENCY = 8;
/** Number of recent closed dividend epochs whose rates are returned. */
export const DIVIDEND_RATE_WINDOW = 24;

/** NEAR account id: 2..64 chars, [a-z0-9] separated by `-`, `_`, `.`. */
const ACCOUNT_ID_RE = /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/;
export function isValidAccountId(id: string): boolean {
  return ACCOUNT_ID_RE.test(id);
}

interface ViewOut {
  text: string;
  block_height: number;
}

async function view(
  client: NearRpcClient,
  contractId: string,
  method: string,
  args: Record<string, unknown>,
): Promise<ViewOut> {
  const r = await client.viewFunction(
    contractId,
    method,
    Buffer.from(JSON.stringify(args)).toString("base64"),
  );
  return { text: r.text, block_height: r.block_height };
}

/** Wrap view call: missing contract account -> `contract_not_deployed`. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | NotDeployed> {
  try {
    return await fn();
  } catch (err) {
    if (isContractNotDeployed(err)) return { error: "contract_not_deployed" };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// /api/strains — enumeration from contract views (not from the event poller)
// ---------------------------------------------------------------------------

export interface StrainListResponse {
  strains: StrainVesselView[];
  starvingCount: number;
  liquidatedCount: number;
  splicedCount: number;
  totalMinted: number;
  truncated: boolean;
  source: string;
  contractId: string;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * List all Strains: `nft_total_supply` (sequential IDs 1..N; Liquidated/SplicedBurned tokens
 * remain in state) followed by `get_strain` per ID. Replaces the event-cache source that was never populated
 * (RPC `chunk` does not carry execution logs).
 */
export async function fetchStrainList(
  client: NearRpcClient,
  contractId: string,
): Promise<StrainListResponse | NotDeployed> {
  return guarded(async () => {
    const supply = await view(client, contractId, "nft_total_supply", {});
    const total = Number(JSON.parse(supply.text) as string);
    if (!Number.isInteger(total) || total < 0) {
      throw new Error(`invalid nft_total_supply: ${supply.text}`);
    }
    const n = Math.min(total, MAX_STRAINS_LISTED);
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    const views = await mapLimit(ids, FETCH_CONCURRENCY, async (id) => {
      try {
        const r = await view(client, contractId, "get_strain", { strain_id: id });
        return JSON.parse(quoteU128Fields(r.text, STRAIN_U128_FIELDS)) as StrainVesselView;
      } catch (err) {
        if (err instanceof ViewPanicError) return null; // ID does not exist (sequence gap)
        throw err;
      }
    });
    const strains = views.filter((v): v is StrainVesselView => v !== null);
    return {
      strains,
      starvingCount: strains.filter((s) => s.status === "Distressed").length,
      liquidatedCount: strains.filter((s) => s.status === "Liquidated").length,
      splicedCount: strains.filter((s) => s.status === "SplicedBurned").length,
      totalMinted: total,
      truncated: total > n,
      source: "view:nft_total_supply+get_strain",
      contractId,
    };
  });
}

// ---------------------------------------------------------------------------
// /api/strains/:id/svg — NEP-177 SVG from nft_token
// ---------------------------------------------------------------------------

const SVG_DATA_URI_PREFIX = "data:image/svg+xml;base64,";

export async function fetchStrainSvg(
  client: NearRpcClient,
  contractId: string,
  strainId: number,
): Promise<{ svg: string } | { error: "strain_not_found" | "svg_media_unavailable" } | NotDeployed> {
  return guarded(async () => {
    let text: string;
    try {
      text = (await view(client, contractId, "nft_token", { token_id: String(strainId) })).text;
    } catch (err) {
      if (err instanceof ViewPanicError) return { error: "strain_not_found" as const };
      throw err;
    }
    const tok = JSON.parse(text) as { metadata?: { media?: string } } | null;
    const media = tok?.metadata?.media;
    if (typeof media !== "string" || !media.startsWith(SVG_DATA_URI_PREFIX)) {
      return { error: "svg_media_unavailable" as const };
    }
    const svg = Buffer.from(media.slice(SVG_DATA_URI_PREFIX.length), "base64").toString("utf8");
    return { svg };
  });
}

// ---------------------------------------------------------------------------
// /api/colony/:owner — get_colony + get_colony_atp (EN-121)
// ---------------------------------------------------------------------------

export interface ColonyResponse {
  owner_id: string;
  strains: StrainVesselView[];
  colonyAtp: string;
  contractId: string;
  blockHeight: number;
}

export async function fetchColony(
  client: NearRpcClient,
  contractId: string,
  ownerId: string,
): Promise<ColonyResponse | NotDeployed> {
  return guarded(async () => {
    const [colony, atp] = await Promise.all([
      view(client, contractId, "get_colony", { owner_id: ownerId }),
      view(client, contractId, "get_colony_atp", { owner_id: ownerId }),
    ]);
    return {
      owner_id: ownerId,
      strains: JSON.parse(quoteU128Fields(colony.text, STRAIN_U128_FIELDS)) as StrainVesselView[],
      colonyAtp: String(JSON.parse(atp.text) as string),
      contractId,
      blockHeight: colony.block_height,
    };
  });
}

// ---------------------------------------------------------------------------
// /api/dividends — get_dividend_pool + get_epoch_dividend_rate (DK-033)
// ---------------------------------------------------------------------------

export interface DividendsResponse {
  industrial_dividend_pool: string;
  epoch_dividend_inflow: string;
  last_closed_epoch: number;
  epoch_dividend_rate: Array<{ epoch: number; rate: string }>;
  contribution?: { epoch: number; strain_id: number; amount: string; claimed: boolean };
  contractId: string;
  blockHeight: number;
}

export async function fetchDividends(
  client: NearRpcClient,
  contractId: string,
  contribution?: { epoch: number; strain_id: number },
): Promise<DividendsResponse | NotDeployed> {
  return guarded(async () => {
    const pool = await view(client, contractId, "get_dividend_pool", {});
    const [poolAmt, inflow, lastClosed] = JSON.parse(pool.text) as [string, string, number];
    const from = Math.max(1, lastClosed - DIVIDEND_RATE_WINDOW + 1);
    const epochs: number[] = [];
    for (let e = from; e <= lastClosed; e++) epochs.push(e);
    const rates = await mapLimit(epochs, FETCH_CONCURRENCY, async (epoch) => {
      const r = await view(client, contractId, "get_epoch_dividend_rate", { epoch });
      return { epoch, rate: String(JSON.parse(r.text) as string) };
    });
    const out: DividendsResponse = {
      industrial_dividend_pool: String(poolAmt),
      epoch_dividend_inflow: String(inflow),
      last_closed_epoch: lastClosed,
      epoch_dividend_rate: rates,
      contractId,
      blockHeight: pool.block_height,
    };
    if (contribution) {
      const c = await view(client, contractId, "get_dividend_contribution", contribution);
      const [amount, claimed] = JSON.parse(c.text) as [string, boolean];
      out.contribution = { ...contribution, amount: String(amount), claimed };
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// /api/appetite — get_appetite_meter + get_top_feeder (EN-112, EN-107)
// ---------------------------------------------------------------------------

const APPETITE_U128_FIELDS = ["feast_volume", "feast_target"] as const;

export interface AppetiteResponse {
  zone: string;
  crucible_temp: number;
  current_epoch: number;
  burst_bps: number;
  burst_until: number;
  burst_epochs_left: number;
  dormant: boolean;
  feast_volume: string;
  feast_target: string;
  risk_heat: number;
  top_feeders: Array<{ account_id: string; amount: string }>;
  contractId: string;
  blockHeight: number;
}

export async function fetchAppetite(
  client: NearRpcClient,
  contractId: string,
): Promise<AppetiteResponse | NotDeployed> {
  return guarded(async () => {
    const meter = await view(client, contractId, "get_appetite_meter", {});
    const m = JSON.parse(quoteU128Fields(meter.text, APPETITE_U128_FIELDS)) as Omit<
      AppetiteResponse,
      "top_feeders" | "contractId" | "blockHeight"
    >;
    const feeders = await view(client, contractId, "get_top_feeder", { epoch: m.current_epoch });
    const top = JSON.parse(quoteU128Fields(feeders.text, ["amount"])) as Array<{
      account_id: string;
      amount: string;
    }>;
    return { ...m, top_feeders: top, contractId, blockHeight: meter.block_height };
  });
}

// ---------------------------------------------------------------------------
// /api/zones — current zone (view) + zone_changed history (event cache)
// ---------------------------------------------------------------------------

export interface ZoneHistoryEntry {
  kind: string;
  block_height: number | null;
  receipt_id: string | null;
  from_zone: string | null;
  to_zone: string | null;
  crucible_temp: number | null;
}

export interface ZonesResponse {
  current: {
    zone: string;
    crucible_temp: number;
    current_epoch: number;
    last_zone: string;
    fever_threshold_mk: number;
    hypothermia_threshold_mk: number;
  };
  history: ZoneHistoryEntry[];
  history_complete: boolean;
  indexer_incomplete: boolean;
  history_note: string;
  contractId: string;
  blockHeight: number;
}

/**
 * Flatten absorbed `zone_changed` events into history entries (EN-106). Block height and
 * receipt id come from the poller (`CrucibleEvent.block_height` / `receipt_id`); zone fields
 * are copied verbatim from the event payload (`from_zone`, `to_zone`, `crucible_temp`). Missing
 * values stay `null` — never fabricated. Entries are ordered ascending by block height
 * (unknown height first), stable for equal heights (absorbed order).
 */
export function buildZoneHistory(events: CrucibleEvent[]): ZoneHistoryEntry[] {
  return events
    .filter((e) => e.kind === "zone_changed")
    .map((e) => ({
      kind: e.kind,
      block_height: e.block_height ?? null,
      receipt_id: e.receipt_id ?? null,
      from_zone: (e.raw["from_zone"] as string) ?? null,
      to_zone: (e.raw["to_zone"] as string) ?? null,
      crucible_temp: (e.raw["crucible_temp"] as number) ?? null,
    }))
    .sort((a, b) => (a.block_height ?? 0) - (b.block_height ?? 0));
}

export async function fetchZones(
  client: NearRpcClient,
  contractId: string,
  zoneEvents: CrucibleEvent[],
  indexerComplete: boolean,
): Promise<ZonesResponse | NotDeployed> {
  return guarded(async () => {
    const [meter, macro] = await Promise.all([
      view(client, contractId, "get_appetite_meter", {}),
      view(client, contractId, "get_macro_state", {}),
    ]);
    const m = JSON.parse(quoteU128Fields(meter.text, APPETITE_U128_FIELDS)) as {
      zone: string;
      crucible_temp: number;
      current_epoch: number;
    };
    const ms = JSON.parse(macro.text) as {
      last_zone: string;
      params: { fever_threshold_mk: number; hypothermia_threshold_mk: number };
    };
    return {
      current: {
        zone: m.zone,
        crucible_temp: m.crucible_temp,
        current_epoch: m.current_epoch,
        last_zone: ms.last_zone,
        fever_threshold_mk: ms.params.fever_threshold_mk,
        hypothermia_threshold_mk: ms.params.hypothermia_threshold_mk,
      },
      history: buildZoneHistory(zoneEvents),
      history_complete: indexerComplete,
      indexer_incomplete: !indexerComplete,
      history_note:
        "zone_changed history only includes events captured by the poller since process start; the contract does not expose a zone history view.",
      contractId,
      blockHeight: meter.block_height,
    };
  });
}
