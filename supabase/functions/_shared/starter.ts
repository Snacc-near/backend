/** `starter-pack` core: one 0.3 testnet NEAR transfer per NEAR account, with a global daily cap. */

import { fail, ok, type HandlerResult } from "./http.ts";
import { FaucetOutcomeUnknownError, STARTER_AMOUNT_YOCTO } from "./near-tx.ts";
import type { PlannedNotification } from "./scan.ts";
import { utcDay } from "./rules.ts";

export const STARTER_DAILY_CAP = 100;

export interface StarterStore {
  nearAccountIdOf(userId: string): Promise<string | null>;
  existingClaim(accountId: string): Promise<{ tx_hash: string | null } | null>;
  /** Insert the claim row (tx_hash null); false when a row for this account already exists. */
  reserveClaim(row: { near_account_id: string; user_id: string; amount_yocto: string }): Promise<boolean>;
  /** Claims created at or after `sinceIso` (includes reservations). */
  claimsSince(sinceIso: string): Promise<number>;
  releaseClaim(accountId: string): Promise<void>;
  completeClaim(accountId: string, txHash: string): Promise<void>;
  insertNotification(n: PlannedNotification): Promise<void>;
}

export interface StarterDeps {
  store: StarterStore;
  /** `null` when `SNACC_FAUCET_ACCOUNT_ID` / `SNACC_FAUCET_PRIVATE_KEY` are not set. */
  sendTransfer: ((receiverId: string, depositYocto: bigint) => Promise<string>) | null;
  viewAccount: (accountId: string) => Promise<{ amount: string } | null>;
  now?: () => number;
  dailyCap?: number;
}

/** POST /starter-pack for the authenticated `userId`. */
export async function handleStarterPack(userId: string, deps: StarterDeps): Promise<HandlerResult> {
  if (!deps.sendTransfer) return fail(503, "not_configured", "The starter pack faucet is not configured.");
  const accountId = await deps.store.nearAccountIdOf(userId);
  if (!accountId) return fail(403, "no_profile", "Sign in with NEAR first.");

  const prior = await deps.store.existingClaim(accountId);
  if (prior) return fail(409, "already_claimed", "This NEAR account already received its starter pack.", { txHash: prior.tx_hash });

  let balance: bigint;
  try {
    const acct = await deps.viewAccount(accountId);
    balance = acct ? BigInt(acct.amount) : 0n;
  } catch {
    return fail(503, "rpc_unavailable", "Could not reach NEAR RPC. Try again.");
  }
  if (balance >= STARTER_AMOUNT_YOCTO) {
    return fail(409, "balance_sufficient", "Your account already holds at least 0.3 testnet NEAR.");
  }

  const amount = STARTER_AMOUNT_YOCTO.toString();
  if (!(await deps.store.reserveClaim({ near_account_id: accountId, user_id: userId, amount_yocto: amount }))) {
    return fail(409, "already_claimed", "This NEAR account already received its starter pack.");
  }
  const now = (deps.now ?? Date.now)();
  const dayStart = `${utcDay(now)}T00:00:00.000Z`;
  if ((await deps.store.claimsSince(dayStart)) > (deps.dailyCap ?? STARTER_DAILY_CAP)) {
    await deps.store.releaseClaim(accountId);
    return fail(429, "daily_cap_reached", "Today's starter packs are gone. Try again tomorrow (UTC).");
  }

  let txHash: string;
  try {
    txHash = await deps.sendTransfer(accountId, STARTER_AMOUNT_YOCTO);
  } catch (e) {
    if (e instanceof FaucetOutcomeUnknownError) {
      // Keep the reservation so a retry cannot pay twice; record the hash for manual follow-up.
      await deps.store.completeClaim(accountId, e.txHash);
      return fail(502, "transfer_unknown", "The faucet transfer was sent but not confirmed. Check your balance shortly.", { txHash: e.txHash });
    }
    await deps.store.releaseClaim(accountId);
    console.error("starter-pack: transfer failed", e instanceof Error ? e.message.slice(0, 200) : "unknown error");
    return fail(502, "transfer_failed", "The faucet transfer failed. Try again later.");
  }
  await deps.store.completeClaim(accountId, txHash);
  await deps.store.insertNotification({
    user_id: userId,
    kind: "starter",
    strain_id: null,
    title: "Starter pack sent",
    body: "0.3 testnet NEAR is on its way to your account (testnet NEAR has no monetary value).",
    dedupe_key: `starter:${accountId}`,
  });
  return ok({ claimed: true, txHash, amountYocto: amount });
}
