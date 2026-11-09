// TEE-101 — Layer 1: Deterministic Local Pre-Redactor (ADR-05, M3 tee-genome-oracle).
// Source of truth: snacc-vault/04 Arsitektur/Snacc - Spec API Backend dan TEE.md §1 Stage 1.
//
// Spec rules:
// - Removes NEAR account patterns (*.near, *.testnet), emails, and ed25519 private keys from the input text.
// - The raw ingredient dosages are hidden behind a commitment:
//     genome_commitment_hash = sha256(raw_formula + secret_salt)
// - A random salt per request; returns { salt_hex, commitment_hex, payload_terredaksi }.
//
// AMBIGUITY (recorded, not resolved):
// A1. The salt length/encoding is not specified → 16 random bytes, hex-encoded.
// A2. The exact "raw dosage" shape is not specified → the caller separates raw_formula
//     as a substring of the payload; in the payload it is replaced with "StoichiometryCommitment: <hash>" + normalized
//     ratios (the proportion per ingredient, 6 decimals).

import { createHash, randomBytes } from "node:crypto";

export const REDACTION_MODE_LOCAL = "local_deterministic_sha256";
export const REDACTION_MODE_CLOUD = "cloud";

/** The NEAR account pattern: `*.near` / `*.testnet` (spec Stage 1 Layer 1). */
const NEAR_ACCOUNT_RE = /\b[a-z0-9_.-]{1,64}\.(?:near|testnet)\b/gi;
/** The email pattern. */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
/** The ed25519 private-key pattern (`ed25519:...` base58). */
const ED25519_KEY_RE = /\bed25519:[1-9A-HJ-NP-Za-km-z]{43,88}\b/g;

const MASK_ACCOUNT = "[REDACTED_ACCOUNT]";
const MASK_EMAIL = "[REDACTED_EMAIL]";
const MASK_KEY = "[REDACTED_KEY]";

/** A SHA-256 hex digest of a string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** A random salt per request — 16 bytes, hex (see ambiguity A1). */
export function newSaltHex(): string {
  return randomBytes(16).toString("hex");
}

/** Remove every identity pattern from the text (NEAR accounts, emails, private keys). */
export function maskIdentity(text: string): string {
  return text
    .replace(ED25519_KEY_RE, MASK_KEY)
    .replace(EMAIL_RE, MASK_EMAIL)
    .replace(NEAR_ACCOUNT_RE, MASK_ACCOUNT);
}

/**
 * Convert the raw dosages into normalized stoichiometric ratios.
 * The recognized format: `Name: number` / `Name=number` pairs, separated by commas/semicolons.
 * The spec example: "Ignis-Spore: 3, Lumin-Spore: 2" → { "Ignis-Spore": 0.6, "Lumin-Spore": 0.4 }.
 * When no pair is detected, return an empty object (the caller raises a warning).
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
  /** A random salt per request (hex). */
  salt_hex: string;
  /** `genome_commitment_hash = sha256(raw_formula + secret_salt)` (a 64-char hex). */
  commitment_hex: string;
  /** The payload after Layer 1: identities removed, raw dosages replaced by the commitment + ratios. */
  payload_terredaksi: string;
  /** The normalized stoichiometric ratio per ingredient. */
  ratios: Record<string, number>;
  /** Non-fatal warnings (e.g. raw_formula not found verbatim in the payload). */
  warnings: string[];
}

/**
 * Layer 1 (deterministic local): mask identities + hide the raw dosages
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
    warnings.push("layer1: no `Name: number` dosage pairs in raw_formula");
  }

  let masked = maskIdentity(payloadText);
  if (rawFormula.length > 0 && masked.includes(rawFormula)) {
    const replacement =
      `StoichiometryCommitment: ${commitment}` +
      ` | NormalizedRatios: ${JSON.stringify(ratios)}`;
    masked = masked.split(rawFormula).join(replacement);
  } else if (rawFormula.length > 0) {
    warnings.push("layer1: raw_formula not found verbatim in the payload; the commitment is still built");
  }

  return {
    salt_hex: salt,
    commitment_hex: commitment,
    payload_terredaksi: masked,
    ratios,
    warnings,
  };
}
