/**
 * Contract view -> /api/crucible/* schema mapping (DOC-113, Backend API Spec).
 * All field names are copied verbatim from `contracts/snacc/src/state.rs` and the spec.
 * No fabricated default values: RPC fields are forwarded as-is.
 */

import { NearRpcClient, ViewPanicError, isContractNotDeployed, quoteU128Fields } from "./near.js";

export interface CrucibleMacroResponse {
  crucibleTemp: number;
  zone: "Fever" | "Goldilocks" | "Hypothermia";
  totalSnaccSupply: string;
  totalSnaccBurned: string;
  ruleBoundTreasury: string;
  epochVolume: string;
  history: unknown[];
  contractId: string;
  blockHeight: number;
}

export interface StrainVesselView {
  strain_id: number;
  owner_id: string;
  vault_subaccount: string;
  vitality: number;
  efficiency_bps: number;
  bmr_per_hour: number;
  last_fed_sec: number;
  role_mask: number;
  state_nonce: number;
  pending_callbacks: number;
  atp_balance: string;
  generation: number;
  organel: { mitokondria: number; nukleus: number; lisosom: number };
  status: string;
  effective_vitality: number;
}

/**
 * Large u128/u64 fields in `StrainVesselView` (numeric literals in RPC -> exact strings).
 * `last_allocate_epoch` uses the u64::MAX sentinel (18446744073709551615) which exceeds float64 precision.
 */
export const STRAIN_U128_FIELDS = ["atp_balance", "last_allocate_epoch"] as const;

export function zoneOf(crucibleTemp: number): "Fever" | "Goldilocks" | "Hypothermia" {
  // `ECON-111` (2026-11-08): FEVER 1400 -> 610 mK (supersedes 1400; 1400 was unreachable -> burn inactive).
  if (crucibleTemp > 610) return "Fever";
  if (crucibleTemp < 600) return "Hypothermia";
  return "Goldilocks";
}

/** Extract u128 from raw JSON text — DO NOT pass through `JSON.parse` (float64 -> scientific notation, loses precision). */
function u128From(text: string, key: string): string {
  const m = text.match(new RegExp(`"${key}":\\s*"?(\\d+)`));
  return m?.[1] ?? "0";
}

export async function fetchMacroState(
  client: NearRpcClient,
  contractId: string,
): Promise<CrucibleMacroResponse | { error: "contract_not_deployed" }> {
  const args = Buffer.from(JSON.stringify({})).toString("base64");
  let text: string;
  let blockHeight: number;
  try {
    const r = await client.viewFunction(contractId, "get_macro_state", args);
    text = r.text;
    blockHeight = r.block_height;
  } catch (err) {
    if (isContractNotDeployed(err)) return { error: "contract_not_deployed" };
    throw err;
  }
  const raw = JSON.parse(text) as Record<string, unknown>;
  const temp = Number(raw["crucible_temp"]);
  return {
    crucibleTemp: temp,
    zone: zoneOf(temp),
    totalSnaccSupply: u128From(text, "total_snacc_supply"),
    totalSnaccBurned: u128From(text, "total_snacc_burned"),
    ruleBoundTreasury: u128From(text, "epoch_treasury_initial"),
    epochVolume: u128From(text, "volume_epoch"),
    history: [],
    contractId,
    blockHeight,
  };
}

export async function fetchStrain(
  client: NearRpcClient,
  contractId: string,
  strainId: number,
): Promise<StrainVesselView | { error: "contract_not_deployed" | "strain_not_found" }> {
  const args = Buffer.from(JSON.stringify({ strain_id: strainId })).toString("base64");
  let text: string;
  try {
    const r = await client.viewFunction(contractId, "get_strain", args);
    text = r.text;
  } catch (err) {
    if (isContractNotDeployed(err)) return { error: "contract_not_deployed" };
    // `get_strain` panics only via ERR_STRAIN_NOT_FOUND (RPC reports WasmTrap without a custom message).
    if (err instanceof ViewPanicError) return { error: "strain_not_found" };
    throw err;
  }
  if (!text || text === "null") return { error: "strain_not_found" };
  return JSON.parse(quoteU128Fields(text, STRAIN_U128_FIELDS)) as StrainVesselView;
}
