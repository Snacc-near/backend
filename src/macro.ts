/**
 * Pemetaan view kontrak -> skema /api/crucible/* (DOC-113, Spec API Backend).
 * Semua nama field disalin persis dari `contracts/snacc/src/state.rs` dan spec.
 * Tidak ada nilai default yang dikarang: field RPC diteruskan apa adanya.
 */

import { NearRpcClient, isContractNotDeployed } from "./near.js";

export interface CrucibleMacroResponse {
  crucibleTemp: number;
  zone: "Fever" | "Goldilocks" | "Hypothermia";
  totalVitaSupply: string;
  totalVitaBurned: string;
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

export function zoneOf(crucibleTemp: number): "Fever" | "Goldilocks" | "Hypothermia" {
  if (crucibleTemp > 1400) return "Fever";
  if (crucibleTemp < 600) return "Hypothermia";
  return "Goldilocks";
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
    totalVitaSupply: String(raw["total_snacc_supply"] ?? "0"),
    totalVitaBurned: String(raw["total_snacc_burned"] ?? "0"),
    ruleBoundTreasury: String(raw["epoch_treasury_initial"] ?? "0"),
    epochVolume: String(raw["volume_epoch"] ?? "0"),
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
    throw err;
  }
  if (!text || text === "null") return { error: "strain_not_found" };
  return JSON.parse(text) as StrainVesselView;
}
