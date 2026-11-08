/**
 * Pemetaan view kontrak -> route baca-saja (VC-020, INT-105..106).
 * Semua data dari view kontrak (`snacc-v001.*`) lewat RPC; nama field disalin persis
 * dari `contracts/snacc/src/{lib,state}.rs`. Tidak ada angka yang dikarang/dihitung ulang.
 */

import {
  NearRpcClient,
  ViewPanicError,
  isContractNotDeployed,
  quoteU128Fields,
} from "./near.js";
import { STRAIN_U128_FIELDS, type StrainVesselView } from "./macro.js";

export type NotDeployed = { error: "contract_not_deployed" };

/** Batas enumerasi strain per permintaan (jaga beban RPC publik). */
export const MAX_STRAINS_LISTED = 200;
const FETCH_CONCURRENCY = 8;
/** Jumlah epoch dividen terakhir yang rate-nya ditampilkan. */
export const DIVIDEND_RATE_WINDOW = 24;

/** NEAR account id: 2..64 karakter, [a-z0-9] dengan pemisah `-`, `_`, `.`. */
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

/** Bungkus panggilan view: akun kontrak tidak ada -> `contract_not_deployed`. */
async function guarded<T>(fn: () => Promise<T>): Promise<T | NotDeployed> {
  try {
    return await fn();
  } catch (err) {
    if (isContractNotDeployed(err)) return { error: "contract_not_deployed" };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// /api/strains — enumerasi dari view (bukan dari poller event)
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
 * Daftar seluruh Strain: `nft_total_supply` (id 1..N berurutan, token Liquidated/SplicedBurned
 * tetap ada) lalu `get_strain` per id. Menggantikan sumber event-cache yang tak pernah terisi
 * (RPC `chunk` tidak membawa log eksekusi).
 */
export async function fetchStrainList(
  client: NearRpcClient,
  contractId: string,
): Promise<StrainListResponse | NotDeployed> {
  return guarded(async () => {
    const supply = await view(client, contractId, "nft_total_supply", {});
    const total = Number(JSON.parse(supply.text) as string);
    if (!Number.isInteger(total) || total < 0) {
      throw new Error(`nft_total_supply tidak valid: ${supply.text}`);
    }
    const n = Math.min(total, MAX_STRAINS_LISTED);
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    const views = await mapLimit(ids, FETCH_CONCURRENCY, async (id) => {
      try {
        const r = await view(client, contractId, "get_strain", { strain_id: id });
        return JSON.parse(quoteU128Fields(r.text, STRAIN_U128_FIELDS)) as StrainVesselView;
      } catch (err) {
        if (err instanceof ViewPanicError) return null; // id tidak ada (celah urutan)
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
// /api/strains/:id/svg — SVG NEP-177 dari nft_token
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
// /api/zones — zona sekarang (view) + riwayat zone_changed (event cache)
// ---------------------------------------------------------------------------

export interface ZonesResponse {
  current: {
    zone: string;
    crucible_temp: number;
    current_epoch: number;
    last_zone: string;
    fever_threshold_mk: number;
    hypothermia_threshold_mk: number;
  };
  history: Array<Record<string, unknown>>;
  history_complete: false;
  history_note: string;
  contractId: string;
  blockHeight: number;
}

export async function fetchZones(
  client: NearRpcClient,
  contractId: string,
  zoneEvents: Array<Record<string, unknown>>,
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
      history: zoneEvents,
      history_complete: false as const,
      history_note:
        "Riwayat zone_changed hanya event yang tertangkap poller sejak proses mulai; kontrak tidak menyediakan view riwayat zona.",
      contractId,
      blockHeight: meter.block_height,
    };
  });
}
