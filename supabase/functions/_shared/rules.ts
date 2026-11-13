/**
 * Pure Snacc rules shared by the Edge Functions and mirrored by the SQL in
 * `supabase/migrations/20261113000001_snacc_core.sql` (achievements trigger + `streaks_snacc` view).
 * Keep both in sync: the unit tests pin the TypeScript side.
 */

/** NEP-413 recipient the frontend signs for (domain separator, not a secret). */
export const AUTH_RECIPIENT = "snacc-nu.vercel.app";
export const NONCE_TTL_MS = 5 * 60 * 1000;

export function challengeMessage(accountId: string): string {
  return `Sign in to Snacc as ${accountId}`;
}

const NAMED_PART = /^(?:[a-z\d]+[-_])*[a-z\d]+$/;

/** Testnet accounts only: a named `*.testnet` account or a 64-hex implicit account. */
export function isValidTestnetAccountId(id: unknown): id is string {
  if (typeof id !== "string" || id.length < 2 || id.length > 64) return false;
  if (/^[0-9a-f]{64}$/.test(id)) return true;
  if (!id.endsWith(".testnet")) return false;
  const parts = id.split(".");
  return parts.length >= 2 && parts.every((p) => NAMED_PART.test(p));
}

/** UTC calendar day `YYYY-MM-DD` of a millisecond timestamp. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

export const ACHIEVEMENT_CODES = [
  "first_hatch",
  "first_feed",
  "feeds_10",
  "streak_3",
  "streak_7",
  "rescuer",
  "gifter",
  "colony_5",
] as const;
export type AchievementCode = (typeof ACHIEVEMENT_CODES)[number];

export interface ActivityLike {
  method: string;
  blockTimeMs: number;
}

/** Longest run of consecutive UTC days with at least one `feed_strain`. */
export function bestFeedStreak(acts: readonly ActivityLike[]): number {
  const days = [...new Set(acts.filter((a) => a.method === "feed_strain").map((a) => dayNumber(utcDay(a.blockTimeMs))))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev = Number.NaN;
  for (const d of days) {
    run = d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return best;
}

/**
 * Current streak as exposed by `streaks_snacc`: length of the run that ends on the last feed day,
 * counted only if that day is today or yesterday (UTC); otherwise 0.
 */
export function currentFeedStreak(acts: readonly ActivityLike[], nowMs: number): { days: number; lastFeedDay: string | null } {
  const days = [...new Set(acts.filter((a) => a.method === "feed_strain").map((a) => dayNumber(utcDay(a.blockTimeMs))))].sort((a, b) => b - a);
  const last = days[0];
  if (last === undefined) return { days: 0, lastFeedDay: null };
  let run = 1;
  for (let i = 1; i < days.length && days[i] === last - i; i++) run++;
  const today = dayNumber(utcDay(nowMs));
  return { days: last >= today - 1 ? run : 0, lastFeedDay: new Date(last * 86_400_000).toISOString().slice(0, 10) };
}

/** Every achievement the activity history qualifies for (the SQL trigger awards the same set). */
export function computeAchievements(acts: readonly ActivityLike[]): Set<AchievementCode> {
  const out = new Set<AchievementCode>();
  const count = (m: string) => acts.filter((a) => a.method === m).length;
  if (count("incubate_strain") > 0) out.add("first_hatch");
  const feeds = count("feed_strain");
  if (feeds > 0) out.add("first_feed");
  if (feeds >= 10) out.add("feeds_10");
  const streak = bestFeedStreak(acts);
  if (streak >= 3) out.add("streak_3");
  if (streak >= 7) out.add("streak_7");
  if (count("adopt") > 0) out.add("rescuer");
  if (count("nft_transfer") > 0) out.add("gifter");
  if (count("incubate_strain") + count("divide_strain") >= 5) out.add("colony_5");
  return out;
}
