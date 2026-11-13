/**
 * `notify-scan` core: read each profile's strains from the contract and plan `starving` / `distressed` /
 * `lost` notifications, deduplicated per (kind, strain, UTC day) and filtered by the user's prefs.
 */

import { NearRpcError } from "./near-rpc.ts";
import { utcDay } from "./rules.ts";

export const TERMINAL_STATUSES = new Set(["Liquidated", "SplicedBurned"]);
export const DISTRESSED_MAX_VITALITY = 2000;

export interface StrainSnapshot {
  strainId: string;
  ownerId: string;
  status: string;
  effectiveVitality: number;
}

export interface NotificationPrefs {
  starving: boolean;
  distressed: boolean;
  lost: boolean;
  dividend: boolean;
  starter: boolean;
  system: boolean;
}

export const DEFAULT_PREFS: NotificationPrefs = {
  starving: true,
  distressed: true,
  lost: true,
  dividend: true,
  starter: true,
  system: true,
};

export type NotificationKind = keyof NotificationPrefs;

export interface PlannedNotification {
  user_id: string;
  kind: NotificationKind;
  strain_id: string | null;
  title: string;
  body: string;
  dedupe_key: string;
}

/** Previous scan: strain id -> last seen status. */
export type ScanMemory = Record<string, string>;

export function dedupeKey(kind: NotificationKind, strainId: string, nowMs: number): string {
  return `${kind}:${strainId}:${utcDay(nowMs)}`;
}

/** Strains seen (alive) in the previous scan but missing from the current owner listing: re-check with `get_strain`. */
export function missingFromListing(previous: ScanMemory | null, current: readonly StrainSnapshot[]): string[] {
  if (!previous) return [];
  const now = new Set(current.map((s) => s.strainId));
  return Object.entries(previous)
    .filter(([id, status]) => !TERMINAL_STATUSES.has(status) && !now.has(id))
    .map(([id]) => id);
}

export interface ScanInput {
  userId: string;
  accountId: string;
  current: readonly StrainSnapshot[];
  previous: ScanMemory | null;
  /** `get_strain` result for each id from `missingFromListing` (`null` = not found). */
  recheck: Record<string, StrainSnapshot | null>;
  prefs: NotificationPrefs;
  nowMs: number;
}

export interface ScanPlan {
  notifications: PlannedNotification[];
  memory: ScanMemory;
}

export function planScan(input: ScanInput): ScanPlan {
  const { userId, accountId, current, previous, recheck, prefs, nowMs } = input;
  const out: PlannedNotification[] = [];
  const memory: ScanMemory = {};
  const push = (kind: NotificationKind, strainId: string, title: string, body: string) => {
    if (!prefs[kind]) return;
    out.push({ user_id: userId, kind, strain_id: strainId, title, body, dedupe_key: dedupeKey(kind, strainId, nowMs) });
  };

  for (const s of current) {
    memory[s.strainId] = s.status;
    const wasAlive = previous !== null && previous[s.strainId] !== undefined && !TERMINAL_STATUSES.has(previous[s.strainId] ?? "");
    if (TERMINAL_STATUSES.has(s.status)) {
      if (wasAlive) {
        const how = s.status === "SplicedBurned" ? "was absorbed in a splice" : "was liquidated (Cell Lysis)";
        push("lost", s.strainId, `Snacc #${s.strainId} is gone`, `Snacc #${s.strainId} ${how}.`);
      }
      continue;
    }
    if (s.effectiveVitality <= 0) {
      push("starving", s.strainId, `Snacc #${s.strainId} is starving`, "Vitality is 0. Feed it now or it can be harvested by anyone.");
    } else if (s.effectiveVitality <= DISTRESSED_MAX_VITALITY) {
      push(
        "distressed",
        s.strainId,
        `Snacc #${s.strainId} is distressed`,
        `Vitality is ${s.effectiveVitality} of 10000. Feed it soon: distressed strains can be taken over.`,
      );
    }
  }

  for (const id of missingFromListing(previous, current)) {
    const r = recheck[id];
    if (r && r.ownerId === accountId && !TERMINAL_STATUSES.has(r.status)) {
      memory[id] = r.status; // still ours (listing was truncated): keep watching
      continue;
    }
    const why = !r ? "is no longer listed" : r.ownerId !== accountId ? "now belongs to another account" : "is gone";
    push("lost", id, `You lost Snacc #${id}`, `Snacc #${id} ${why}.`);
  }
  return { notifications: out, memory };
}

// ---------------------------------------------------------------------------------------------
// Contract reads
// ---------------------------------------------------------------------------------------------

export interface StrainView {
  strain_id: number;
  owner_id: string;
  status: string;
  effective_vitality: number;
}

export function toSnapshot(v: StrainView): StrainSnapshot {
  return { strainId: String(v.strain_id), ownerId: v.owner_id, status: String(v.status), effectiveVitality: Number(v.effective_vitality) };
}

export type ViewFn = <T>(method: string, args: unknown) => Promise<T>;

/** Owned strains: `nft_tokens_for_owner` paged (`pageSize`, at most `maxStrains`) then `get_strain` each. */
export async function readOwnedStrains(view: ViewFn, accountId: string, pageSize = 50, maxStrains = 100): Promise<StrainSnapshot[]> {
  const ids: string[] = [];
  for (let from = 0; ids.length < maxStrains; from += pageSize) {
    const page = await view<Array<{ token_id: string }>>("nft_tokens_for_owner", {
      account_id: accountId,
      from_index: String(from),
      limit: pageSize,
    });
    for (const t of page) if (ids.length < maxStrains) ids.push(String(t.token_id));
    if (page.length < pageSize) break;
  }
  const out: StrainSnapshot[] = [];
  for (const id of ids) out.push(toSnapshot(await view<StrainView>("get_strain", { strain_id: Number(id) })));
  return out;
}

/** `get_strain` that maps a missing strain (contract panic) to `null`; RPC outages are rethrown. */
export async function readStrainOrNull(view: ViewFn, id: string): Promise<StrainSnapshot | null> {
  try {
    return toSnapshot(await view<StrainView>("get_strain", { strain_id: Number(id) }));
  } catch (e) {
    if (e instanceof NearRpcError && e.kind === "rpc" && e.rpcName !== "INTERNAL_ERROR") return null;
    throw e;
  }
}
