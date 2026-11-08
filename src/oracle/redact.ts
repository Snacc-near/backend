// TEE-101 — Layer 1: Deterministic Local Pre-Redactor (ADR-05, M3 tee-genome-oracle).
// Sumber kebenaran: snacc-vault/04 Arsitektur/Snacc - Spec API Backend dan TEE.md §1 Tahap 1.
//
// Aturan spec:
// - Menghapus pola akun NEAR (*.near, *.testnet), email, dan kunci privat ed25519 dari teks input.
// - Takaran bahan mentah disembunyikan di balik komitmen:
//     genome_commitment_hash = sha256(raw_formula + secret_salt)
// - Salt acak per request; kembalikan { salt_hex, commitment_hex, payload_terredaksi }.
//
// AMBIGUITAS (dicatat, tidak diarang):
// A1. Panjang/encoding salt tidak dispesifikkan spec -> dipakai 16 byte acak, dikodekan hex.
// A2. Bentuk tepat "takaran mentah" tidak dispesifikkan -> raw_formula dipisahkan pemanggil
//     sebagai substring payload; di payload diganti "StoichiometryCommitment: <hash>" + rasio
//     ternormalisasi (proporsi per bahan, 6 desimal).

import { createHash, randomBytes } from "node:crypto";

export const REDACTION_MODE_LOCAL = "local_deterministic_sha256";
export const REDACTION_MODE_CLOUD = "cloud";

/** Pola akun NEAR: `*.near` / `*.testnet` (spec Tahap 1 Layer 1). */
const NEAR_ACCOUNT_RE = /\b[a-z0-9_.-]{1,64}\.(?:near|testnet)\b/gi;
/** Pola email. */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** Pola kunci privat ed25519 (`ed25519:...` base58). */
const ED25519_KEY_RE = /\bed25519:[1-9A-HJ-NP-Za-km-z]{43,88}\b/g;

const MASK_ACCOUNT = "[REDACTED_ACCOUNT]";
const MASK_EMAIL = "[REDACTED_EMAIL]";
const MASK_KEY = "[REDACTED_KEY]";

/** SHA-256 hex atas string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Salt acak per request — 16 byte, hex (lihat ambiguitas A1). */
export function newSaltHex(): string {
  return randomBytes(16).toString("hex");
}

/** Hapus seluruh pola identitas dari teks (akun NEAR, email, kunci privat). */
export function maskIdentity(text: string): string {
  return text
    .replace(ED25519_KEY_RE, MASK_KEY)
    .replace(EMAIL_RE, MASK_EMAIL)
    .replace(NEAR_ACCOUNT_RE, MASK_ACCOUNT);
}

/**
 * Konversi takaran mentah menjadi rasio stoikiometri ternormalisasi.
 * Format yang dikenali: pasangan `Nama: angka` / `Nama=angka`, dipisah koma/titik-koma.
 * Contoh spec: "Ignis-Spore: 3, Lumin-Spore: 2" -> { "Ignis-Spore": 0.6, "Lumin-Spore": 0.4 }.
 * Bila tidak ada pasangan terdeteksi, kembalikan objek kosong (pemanggil menandai warning).
 */
export function normalizeRatios(rawFormula: string): Record<string, number> {
  const pairRe = /([A-Za-z][A-Za-z0-9_-]*)\s*[:=]\s*(\d+(?:\.\d+)?)/g;
  const amounts: Array<[string, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(rawFormula)) !== null) {
    const name = m[1];
    const value = Number.parseFloat(m[2] as string);
    if (name !== undefined && Number.isFinite(value)) amounts.push([name, value]);
  }
  const total = amounts.reduce((acc, [, v]) => acc + v, 0);
  if (amounts.length === 0 || total <= 0) return {};
  const ratios: Record<string, number> = {};
  for (const [name, value] of amounts) {
    ratios[name] = Math.round((value / total) * 1e6) / 1e6;
  }
  return ratios;
}

export interface Layer1Result {
  /** Salt acak per request (hex). */
  salt_hex: string;
  /** `genome_commitment_hash = sha256(raw_formula + secret_salt)` (hex 64 karakter). */
  commitment_hex: string;
  /** Payload setelah Layer 1: identitas terhapus, takaran mentah diganti komitmen + rasio. */
  payload_terredaksi: string;
  /** Rasio stoikiometri ternormalisasi per bahan. */
  ratios: Record<string, number>;
  /** Peringatan non-fatal (mis. raw_formula tidak ditemukan verbatim di payload). */
  warnings: string[];
}

/**
 * Layer 1 (deterministik lokal): mask identitas + sembunyikan takaran mentah
 * di balik komitmen SHA-256 ber-garam. Tidak melakukan I/O — selalu berhasil.
 */
export function redactLayer1(
  payloadText: string,
  rawFormula: string,
  saltHex?: string,
): Layer1Result {
  const warnings: string[] = [];
  const salt = saltHex ?? newSaltHex();
  const commitment = sha256Hex(`${rawFormula.trim()}${salt}`);
  const ratios = normalizeRatios(rawFormula);
  if (Object.keys(ratios).length === 0) {
    warnings.push("layer1: tidak ada pasangan takaran `Nama: angka` di raw_formula");
  }

  let masked = maskIdentity(payloadText);
  if (rawFormula.length > 0 && masked.includes(rawFormula)) {
    const replacement =
      `StoichiometryCommitment: ${commitment}` +
      ` | NormalizedRatios: ${JSON.stringify(ratios)}`;
    masked = masked.split(rawFormula).join(replacement);
  } else if (rawFormula.length > 0) {
    warnings.push("layer1: raw_formula tidak ditemukan verbatim di payload; komitmen tetap dibuat");
  }

  return {
    salt_hex: salt,
    commitment_hex: commitment,
    payload_terredaksi: masked,
    ratios,
    warnings,
  };
}
