/**
 * Pure XP, level, quest and season rules (UI-153, UI-154), mirrored by the SQL in
 * `supabase/migrations/20261113000004_snacc_quests_seasons.sql` (`snacc_action_xp`, `snacc_level_for_xp`,
 * `quest_catalog_snacc`, `snacc_season_of`, ...). Keep both in sync: the unit tests pin the TypeScript side and
 * `supabase/tests/snacc_quests_seasons.sql` pins the SQL side with the same numbers.
 *
 * XP, levels, quests and seasons are cosmetic and off-chain: no token, no NEAR, no money value.
 * Which three quests a player gets on a given day is chosen in SQL (md5 order) and is not mirrored here.
 */

/** XP per recorded `activity_snacc.method`; any other method earns {@link DEFAULT_ACTION_XP}. */
export const ACTION_XP: Readonly<Record<string, number>> = {
  incubate_strain: 25,
  splice_strains: 20,
  divide_strain: 15,
  adopt: 15,
  synthesize_and_redeem_aether: 12,
  feed_strain: 10,
  synthesize_elixir: 10,
  allocate_atp: 8,
  transmute_spores_to_enzyme: 8,
  extract_spores: 6,
  nft_transfer: 5,
  npc_buy_spores: 4,
};
export const DEFAULT_ACTION_XP = 2;
/** Only the first this-many actions of a player per UTC day earn action XP. */
export const DAILY_ACTION_CAP = 40;

export function actionXp(method: string | null | undefined): number {
  if (method === null || method === undefined || !Object.hasOwn(ACTION_XP, method)) return DEFAULT_ACTION_XP;
  return ACTION_XP[method] ?? DEFAULT_ACTION_XP;
}

export interface QuestDef {
  code: string;
  title: string;
  blurb: string;
  /** `activity_snacc.method` values that count toward the quest. */
  methods: readonly string[];
  target: number;
  bonusXp: number;
}

/** Same ten rows as the view `quest_catalog_snacc`. */
export const QUEST_CATALOG: readonly QuestDef[] = [
  { code: "feed_1", title: "Snack time", blurb: "Feed any Snacc once.", methods: ["feed_strain"], target: 1, bonusXp: 10 },
  { code: "feed_3", title: "Three meals", blurb: "Feed your Snaccs three times.", methods: ["feed_strain"], target: 3, bonusXp: 25 },
  { code: "allocate_atp", title: "Spend your ATP", blurb: "Allocate ATP on one Snacc.", methods: ["allocate_atp"], target: 1, bonusXp: 15 },
  { code: "extract_2", title: "Spore picker", blurb: "Run the Extractor twice.", methods: ["extract_spores"], target: 2, bonusXp: 20 },
  { code: "transmute_1", title: "Fermenter shift", blurb: "Run the Fermenter once.", methods: ["transmute_spores_to_enzyme"], target: 1, bonusXp: 20 },
  { code: "synthesize_1", title: "Elixir maker", blurb: "Run the Synthesizer once.", methods: ["synthesize_elixir"], target: 1, bonusXp: 25 },
  {
    code: "stages_3",
    title: "Full production line",
    blurb: "Run any three production stages (extract, transmute, synthesize).",
    methods: ["extract_spores", "transmute_spores_to_enzyme", "synthesize_elixir"],
    target: 3,
    bonusXp: 30,
  },
  { code: "hatch_1", title: "New arrival", blurb: "Hatch a new Snacc.", methods: ["incubate_strain"], target: 1, bonusXp: 30 },
  { code: "divide_1", title: "Cell division", blurb: "Divide a Snacc.", methods: ["divide_strain"], target: 1, bonusXp: 25 },
  { code: "buy_spores_1", title: "Merchant visit", blurb: "Buy spores from an NPC merchant.", methods: ["npc_buy_spores"], target: 1, bonusXp: 15 },
];

/** Progress of one quest from the methods of a player's actions on one UTC day. */
export function questProgress(quest: QuestDef, methodsOfDay: readonly string[]): { progress: number; completed: boolean } {
  const progress = methodsOfDay.filter((m) => quest.methods.includes(m)).length;
  return { progress, completed: progress >= quest.target };
}

/** Action XP of one UTC day: the first {@link DAILY_ACTION_CAP} actions (in block order) earn XP. */
export function dayActionXp(methodsInBlockOrder: readonly string[]): number {
  return methodsInBlockOrder.slice(0, DAILY_ACTION_CAP).reduce((sum, m) => sum + actionXp(m), 0);
}

/** XP needed to reach `level` (level 1 = 0): 50 * (L - 1) * L. */
export function xpForLevel(level: number): number {
  const l = Math.max(Math.trunc(level), 1);
  return 50 * (l - 1) * l;
}

/** Highest level whose threshold is at most `xp`. */
export function levelForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 1;
  let l = Math.max(1, Math.floor((1 + Math.sqrt(1 + (2 * xp) / 25)) / 2));
  while (xpForLevel(l + 1) <= xp) l++;
  while (l > 1 && xpForLevel(l) > xp) l--;
  return l;
}

const DAY_MS = 86_400_000;
/** Season 1 starts on this Monday (UTC midnight), `snacc_season_epoch()` in SQL. */
export const SEASON_EPOCH_MS = Date.UTC(2026, 10, 2);
export const SEASON_DAYS = 7;

/** UTC midnight (ms) of the day containing `ms`. */
export const utcMidnight = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** Season number of the UTC day containing `ms` (1 = the week from the epoch; 0 and below = before it). */
export function seasonOf(ms: number): number {
  return Math.floor((utcMidnight(ms) - SEASON_EPOCH_MS) / (SEASON_DAYS * DAY_MS)) + 1;
}

/** First instant (UTC Monday 00:00) of a season. */
export function seasonStartMs(season: number): number {
  return SEASON_EPOCH_MS + (season - 1) * SEASON_DAYS * DAY_MS;
}

/** First instant after a season (the next season's start). */
export function seasonEndMs(season: number): number {
  return seasonStartMs(season) + SEASON_DAYS * DAY_MS;
}
