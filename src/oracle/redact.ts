// TEE-101 — Layer 1: Deterministic Local Pre-Redactor (ADR-05, M3 tee-genome-oracle).
// Source of truth: Backend and TEE API Specification (`snacc-vault`) §1 Stage 1.
//
// Spec rules:
// - Strip NEAR account patterns (*.near, *.testnet), emails, and ed25519 private keys from input text.
// - Raw ingredient amounts are hidden behind a salted commitment:
//     genome_commitment_hash = sha256(raw_formula + secret_salt)
// - Random salt per request; return { salt_hex, commitment_hex, payload_terredaksi }.
//
// AMBIGUITIES (recorded, not invented):
// A1. Salt length/encoding is not specified -> uses 16 random bytes, hex-encoded.
// A2. Exact shape of "raw amounts" is not specified -> raw_formula is separated by the caller
//     as a payload substring; in the payload it is replaced by "StoichiometryCommitment: <hash>" +
//     normalized ratios (proportion per ingredient, 6 decimal places).

import { createHash, randomBytes } from "node:crypto";

export const REDACTION_MODE_LOCAL = "local_deterministic_sha256";
export const REDACTION_MODE_CLOUD = "cloud";

/** NEAR account pattern: `*.near` / `*.testnet` (spec Stage 1 Layer 1). */
const NEAR_ACCOUNT_RE = /\b[a-z0-9_.-]{1,64}\.(?:near|testnet)\b/gi;
/** Email pattern. */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** ed25519 key pattern (`ed25519:...` base58). */
const ED25519_KEY_RE = /\bed25519:[1-9A-HJ-NP-Za-km-z]{43,88}\b/g;

const MASK_ACCOUNT = "[REDACTED_ACCOUNT]";
const MASK_EMAIL = "[REDACTED_EMAIL]";
const MASK_KEY = "[REDACTED_KEY]";

/** SHA-256 hex digest of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Random per-request salt — 16 bytes, hex (see ambiguity A1). */
export function newSaltHex(): string {
  return randomBytes(16).toString("hex");
}

/** Strip all identity patterns from text (NEAR accounts, emails, private keys). */
export function maskIdentity(text: string): string {
  return text
    .replace(ED25519_KEY_RE, MASK_KEY)
    .replace(EMAIL_RE, MASK_EMAIL)
    .replace(NEAR_ACCOUNT_RE, MASK_ACCOUNT);
}

/**
 * Convert raw ingredient amounts into normalized stoichiometric ratios.
 * Recognized format: `Name: number` / `Name=number` pairs separated by commas/semicolons.
 * Spec example: "Ignis-Spore: 3, Lumin-Spore: 2" -> { "Ignis-Spore": 0.6, "Lumin-Spore": 0.4 }.
 * If no pairs are detected, returns an empty object (caller records a warning).
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
  /** Random per-request salt (hex). */
  salt_hex: string;
  /** `genome_commitment_hash = sha256(raw_formula + secret_salt)` (64-char hex). */
  commitment_hex: string;
  /** Payload after Layer 1: identity stripped, raw amounts replaced with commitment + ratios. */
  payload_terredaksi: string;
  /** Normalized stoichiometric ratios per ingredient. */
  ratios: Record<string, number>;
  /** Non-fatal warnings (e.g. raw_formula not found verbatim in payload). */
  warnings: string[];
}

/**
 * Layer 1 (deterministic local): mask identity + hide raw ingredient amounts
 * behind a salted SHA-256 commitment. Performs no I/O — always succeeds.
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
    warnings.push("layer1: no `Name: number` ratio pairs found in raw_formula");
  }

  let masked = maskIdentity(payloadText);
  if (rawFormula.length > 0 && masked.includes(rawFormula)) {
    const replacement =
      `StoichiometryCommitment: ${commitment}` +
      ` | NormalizedRatios: ${JSON.stringify(ratios)}`;
    masked = masked.split(rawFormula).join(replacement);
  } else if (rawFormula.length > 0) {
    warnings.push("layer1: raw_formula not found verbatim in payload; commitment still created");
  }

  return {
    salt_hex: salt,
    commitment_hex: commitment,
    payload_terredaksi: masked,
    ratios,
    warnings,
  };
}
