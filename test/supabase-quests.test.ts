// XP / level / quest / season rules (UI-153, UI-154): the TypeScript mirror in `_shared/xp.ts`, pinned to the
// same numbers as `supabase/tests/snacc_quests_seasons.sql`, and to the migration text itself so the two sides
// cannot drift apart silently.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ACTION_XP,
  DAILY_ACTION_CAP,
  DEFAULT_ACTION_XP,
  QUEST_CATALOG,
  SEASON_EPOCH_MS,
  actionXp,
  dayActionXp,
  levelForXp,
  questProgress,
  seasonEndMs,
  seasonOf,
  seasonStartMs,
  xpForLevel,
} from "../supabase/functions/_shared/xp.js";

const MIGRATION = readFileSync(new URL("../../supabase/migrations/20261113000004_snacc_quests_seasons.sql", import.meta.url), "utf8");
const at = (iso: string) => Date.parse(iso);

test("action XP table, default and daily cap", () => {
  assert.deepEqual(
    ["incubate_strain", "splice_strains", "divide_strain", "adopt", "synthesize_and_redeem_aether", "feed_strain", "synthesize_elixir", "allocate_atp", "transmute_spores_to_enzyme", "extract_spores", "nft_transfer", "npc_buy_spores", "advance_epoch"].map(actionXp),
    [25, 20, 15, 15, 12, 10, 10, 8, 8, 6, 5, 4, 2],
  );
  assert.equal(actionXp(null), DEFAULT_ACTION_XP);
  assert.equal(actionXp(undefined), DEFAULT_ACTION_XP);
  assert.equal(actionXp("toString"), DEFAULT_ACTION_XP, "inherited object keys are not methods");
  assert.equal(DAILY_ACTION_CAP, 40);
  // 45 feeds on one UTC day: only the first 40 earn XP
  assert.equal(dayActionXp(Array.from({ length: 45 }, () => "feed_strain")), 400);
  assert.equal(dayActionXp(["nft_transfer", "npc_buy_spores", "transmute_spores_to_enzyme", "feed_strain"]), 27);
  assert.equal(dayActionXp([]), 0);
});

test("level curve: 50 * (L - 1) * L, boundaries and the inverse", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 10].map(xpForLevel), [0, 100, 300, 600, 1000, 4500]);
  assert.deepEqual([null, -5, 0, 99, 100, 299, 300, 599, 600, 999, 1000, 4499, 4500].map((x) => levelForXp(x ?? Number.NaN)), [1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 9, 10]);
  for (let l = 1; l <= 300; l++) {
    assert.equal(levelForXp(xpForLevel(l)), l, `level ${l} at its own threshold`);
    if (l > 1) assert.equal(levelForXp(xpForLevel(l) - 1), l - 1, `level ${l - 1} one XP short`);
  }
});

test("quest progress counts only the quest's methods and completes at the target", () => {
  const stages = QUEST_CATALOG.find((q) => q.code === "stages_3")!;
  assert.deepEqual(questProgress(stages, ["extract_spores", "feed_strain", "synthesize_elixir"]), { progress: 2, completed: false });
  assert.deepEqual(questProgress(stages, ["extract_spores", "transmute_spores_to_enzyme", "synthesize_elixir", "extract_spores"]), { progress: 4, completed: true });
  const feed1 = QUEST_CATALOG.find((q) => q.code === "feed_1")!;
  assert.deepEqual(questProgress(feed1, []), { progress: 0, completed: false });
  assert.deepEqual(questProgress(feed1, ["feed_strain"]), { progress: 1, completed: true });
});

test("seasons: Monday-to-Monday UTC weeks from the 2026-11-02 epoch", () => {
  assert.equal(SEASON_EPOCH_MS, at("2026-11-02T00:00:00Z"));
  assert.equal(new Date(SEASON_EPOCH_MS).getUTCDay(), 1, "the epoch is a Monday");
  const cases: [string, number][] = [
    ["2026-10-25T12:00:00Z", -1],
    ["2026-10-26T12:00:00Z", 0],
    ["2026-11-01T23:59:59Z", 0],
    ["2026-11-02T00:00:00Z", 1],
    ["2026-11-08T23:59:59Z", 1],
    ["2026-11-09T00:00:00Z", 2],
    ["2026-11-15T23:59:59Z", 2],
    ["2026-11-16T00:00:00Z", 3],
  ];
  for (const [iso, season] of cases) assert.equal(seasonOf(at(iso)), season, iso);
  assert.equal(seasonStartMs(3), at("2026-11-16T00:00:00Z"));
  assert.equal(seasonEndMs(2), at("2026-11-16T00:00:00Z"));
  for (let day = 0; day < 730; day++) {
    const ms = at("2026-01-01T05:00:00Z") + day * 86_400_000;
    const s = seasonOf(ms);
    assert.ok(seasonStartMs(s) <= ms && ms < seasonEndMs(s), `day ${day} sits in its own week`);
    assert.equal(new Date(seasonStartMs(s)).getUTCDay(), 1);
  }
});

test("the TypeScript mirror matches the migration text (XP table, cap, epoch, quest catalog)", () => {
  // snacc_action_xp: `when '<method>' then <n>` lines plus `else <n>`
  const xp = Object.fromEntries([...MIGRATION.matchAll(/when '([a-z_]+)' then (\d+)/g)].map((m) => [m[1]!, Number(m[2])]));
  assert.deepEqual(xp, ACTION_XP);
  assert.equal(Number(/\n\s+else (\d+)\n\s+end\n\$\$;/.exec(MIGRATION)?.[1]), DEFAULT_ACTION_XP);
  assert.equal(Number(/snacc_xp_daily_action_cap\(\)[^$]*\$\$ select (\d+) \$\$/.exec(MIGRATION)?.[1]), DAILY_ACTION_CAP);
  assert.equal(/snacc_season_epoch\(\)[^$]*\$\$ select date '([\d-]+)' \$\$/.exec(MIGRATION)?.[1], "2026-11-02");

  // quest_catalog_snacc rows: ('code', 'title', 'blurb', array['m', ...]::text[], target, bonus)
  const rows = [...MIGRATION.matchAll(/\('([a-z0-9_]+)',\s+'([^']+)',\s+'([^']+)',\s+array\[([^\]]+)\]::text\[\],\s+(\d+),\s+(\d+)\)/g)].map((m) => ({
    code: m[1]!,
    title: m[2]!,
    blurb: m[3]!,
    methods: [...m[4]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!),
    target: Number(m[5]),
    bonusXp: Number(m[6]),
  }));
  assert.equal(rows.length, 10);
  assert.deepEqual(rows, QUEST_CATALOG.map((q) => ({ ...q, methods: [...q.methods] })));
  // every quest counts only methods that earn their own XP
  for (const q of QUEST_CATALOG) for (const m of q.methods) assert.ok(actionXp(m) > DEFAULT_ACTION_XP, `${q.code}: ${m}`);
});
