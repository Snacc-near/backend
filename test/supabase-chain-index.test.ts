// chain-index (UI-155 lineage + history, UI-156 graveyard): NEP-297 log parsing, NearBlocks v3 listing, cursor/batching logic.
// Fixtures are REAL snacc-v001.testnet data (fetched read-only on 2026-11-13):
//   test/fixtures/chain-tx-*.json                  EXPERIMENTAL_tx_status answers (FastNEAR regular / archival testnet RPC):
//     divide GVwhXD6k..., divide_today 81vVZ5cu..., splice 8M41CAwA..., hostile 4o4qwoGZ..., adopt 7w3tBNjL..., harvest AhEk4TNN...,
//     nft_transfer HfhZG6sA..., ft_transfer FQ6R9fmK..., ft_burn ERBRL4rT..., feed EbYbVWzV..., incubate zx8ASZjo..., extract CfBR8pFN...,
//     transmute 3Efj27mt..., synthesize q5nP4ygL..., allocate 2LnyPshQ..., redeem_aether GfqatLA7..., claim_dividend 6hPrMTJu...,
//     npc_buy 2VCzPuL5..., commit_genome EnXBEETd..., tee_mutation B8xdaukd..., advance_epoch 9F4KGd9b..., register_signer BovEAtK5...,
//     splice_failed HdYaP5FC... (a tx that failed: no events)
//   test/fixtures/nearblocks-v3-txns-page1.json    first page (100 newest txs) of GET /v3/accounts/snacc-v001.testnet/txns?limit=100
//   test/fixtures/nearblocks-v3-txns-last-page.json the last page (62 oldest txs, no next cursor)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ARCHIVAL_AGE_MS,
  LOOKBACK_NS,
  MAX_RETRY_ATTEMPTS,
  NearBlocksError,
  classifyTx,
  cloneState,
  emptyState,
  extractEvents,
  fetchTxOutcome,
  isWellFormed,
  nearBlocksTxnsUrl,
  normalizeState,
  nsToIso,
  parseEventLine,
  parseNearBlocksPage,
  quoteBigInts,
  resolveMarketId,
  runIndex,
  stateResetRow,
  type IndexDeps,
  type IndexLimits,
  type IndexState,
  type ListPage,
  type ListedTx,
  type TxPlan,
} from "../supabase/functions/_shared/chain-index.js";
import { NearRpc } from "../supabase/functions/_shared/near-rpc.js";

const CONTRACT = "snacc-v001.testnet";
const fixtureUrl = (name: string): URL => new URL(`../../test/fixtures/${name}`, import.meta.url);
const readJson = (name: string): unknown => JSON.parse(readFileSync(fixtureUrl(name), "utf8"));
const txFixture = (name: string): { result: Record<string, unknown> } => readJson(`chain-tx-${name}.json`) as { result: Record<string, unknown> };
const ctxFor = (name: string) => {
  const t = txFixture(name).result["transaction"] as { hash: string; signer_id: string };
  return { txHash: t.hash, signerId: t.signer_id, blockHeight: 276920000, blockTime: "2026-11-09T12:28:00.000Z" };
};
const events = (name: string) => extractEvents(txFixture(name).result, ctxFor(name), CONTRACT);
const names = (name: string) => events(name).events.map((e) => `${e.standard}/${e.event}`);

// ---------------------------------------------------------------------------------------------
// EVENT_JSON parsing
// ---------------------------------------------------------------------------------------------

test("quoteBigInts keeps u128 amounts exact and leaves strings, short ints, decimals and nulls alone", () => {
  const raw = '{"a":390550000000000000000,"b":42,"c":"12345678901234567890","d":1.5,"e":null,"f":[7,1234567890123456],"g":"x\\"1234567890123456789"}';
  assert.equal(
    quoteBigInts(raw),
    '{"a":"390550000000000000000","b":42,"c":"12345678901234567890","d":1.5,"e":null,"f":[7,"1234567890123456"],"g":"x\\"1234567890123456789"}',
  );
  assert.deepEqual(JSON.parse(quoteBigInts('{"n":-1234567890123456789}')), { n: "-1234567890123456789" });
  assert.deepEqual(JSON.parse(quoteBigInts("[1e3, 15, 2.5e10]")), [1000, 15, 25000000000]);
});

test("parseEventLine: real strain_divided line keeps the 24-digit balances as exact strings", () => {
  const line =
    'EVENT_JSON:{"standard":"snacc","version":"1.0.0","event":"strain_divided","data":[{"kind":"strain_divided","parent_id":1,"child_id":6,"child_generation":3,"parent_balance":434463694500699999997225,"child_balance":434463694500699999997225,"child_vitality":5000,"child_spores":25}]}';
  const e = parseEventLine(line);
  assert.ok(e);
  assert.equal(e.standard, "snacc");
  assert.equal(e.event, "strain_divided");
  assert.equal(e.data["parent_id"], 1);
  assert.equal(e.data["child_balance"], "434463694500699999997225");
  assert.ok(isWellFormed(e));
});

test("parseEventLine rejects what is not a one-element NEP-297 event", () => {
  const ok = 'EVENT_JSON:{"standard":"snacc","version":"1.0.0","event":"fed","data":[{"kind":"fed","strain_id":1,"effective_fee":5}]}';
  assert.ok(parseEventLine(ok));
  assert.equal(parseEventLine("just a log line"), null);
  assert.equal(parseEventLine("EVENT_JSON:not json"), null);
  assert.equal(parseEventLine('EVENT_JSON:{"standard":"snacc","version":"1.0.0","event":"fed","data":{}}'), null); // data not an array
  assert.equal(parseEventLine('EVENT_JSON:{"standard":"snacc","version":"1.0.0","event":"fed","data":[]}'), null);
  assert.equal(parseEventLine('EVENT_JSON:{"standard":"snacc","version":"1.0.0","event":"fed","data":[{},{}]}'), null); // two elements
  assert.equal(parseEventLine('EVENT_JSON:{"standard":"snacc","version":"1.0.0","data":[{}]}'), null); // no event name
  assert.equal(parseEventLine('EVENT_JSON:{"standard":1,"version":"1.0.0","event":"fed","data":[{}]}'), null);
  assert.equal(parseEventLine(`EVENT_JSON:${"x".repeat(30_000)}`), null);
});

test("isWellFormed guards every field the SQL views cast", () => {
  const mk = (event: string, data: Record<string, unknown>, standard = "snacc") => ({ standard, version: "1.0.0", event, data });
  assert.equal(isWellFormed(mk("strain_divided", { parent_id: 1, child_id: 2, child_generation: 1, child_balance: "5" })), true);
  assert.equal(isWellFormed(mk("strain_divided", { parent_id: "x", child_id: 2, child_generation: 1, child_balance: "5" })), false);
  assert.equal(isWellFormed(mk("strain_divided", { parent_id: 1, child_id: 2, child_generation: 1 })), false);
  assert.equal(isWellFormed(mk("strain_liquidated", { target_id: 4, bounty: "7", liquidator: "a.testnet" })), true);
  assert.equal(isWellFormed(mk("strain_liquidated", { target_id: 4, bounty: "7" })), false);
  assert.equal(isWellFormed(mk("strain_adopted", { target_id: 4, raider_strain_id: 2, book_value: "7" })), false); // adopter missing
  assert.equal(isWellFormed(mk("nft_transfer", { token_ids: ["3"], old_owner_id: "a", new_owner_id: "b" }, "nep171")), true);
  assert.equal(isWellFormed(mk("nft_transfer", { token_ids: [3] }, "nep171")), false);
  assert.equal(isWellFormed(mk("nft_transfer", { token_ids: [] }, "nep171")), false);
  assert.equal(isWellFormed(mk("ft_transfer", { amount: "x" }, "nep141")), true); // not used by a view
  assert.equal(isWellFormed(mk("some_future_event", { anything: true })), true);
});

// ---------------------------------------------------------------------------------------------
// Receipts -> rows, on real transactions
// ---------------------------------------------------------------------------------------------

test("extractEvents: every real fixture gives exactly the events the contract emitted, in log order", () => {
  const expected: Record<string, string[]> = {
    divide: ["snacc/atp_spent", "snacc/strain_divided"],
    divide_today: ["snacc/atp_spent", "snacc/strain_divided"],
    splice: ["snacc/atp_spent", "snacc/strains_spliced"],
    hostile: ["snacc/atp_spent", "snacc/hostile_takeover_spliced"],
    adopt: ["snacc/strain_adopted"],
    harvest: ["snacc/strain_liquidated", "snacc/nutrient_burst_released"],
    nft_transfer: ["nep171/nft_transfer"],
    ft_transfer: ["nep141/ft_transfer"],
    ft_burn: ["nep141/ft_burn"],
    feed: ["snacc/dividend_inflow", "snacc/fed"],
    incubate: ["nep141/ft_mint", "snacc/strain_created"],
    extract: ["snacc/zone_changed", "snacc/dividend_inflow", "snacc/atp_spent", "snacc/extracted"],
    transmute: ["snacc/dividend_inflow", "snacc/atp_spent", "snacc/transmuted"],
    synthesize: ["snacc/dividend_inflow", "snacc/atp_spent", "snacc/synthesized"],
    allocate: ["snacc/atp_allocated"],
    redeem_aether: ["snacc/aether_burned_for_dividend"],
    claim_dividend: ["snacc/dividend_claimed"],
    npc_buy: ["snacc/npc_spores_bought"],
    commit_genome: ["snacc/genome_committed"],
    tee_mutation: ["snacc/genome_mutated"],
    advance_epoch: ["snacc/feast_result", "snacc/epoch_dividend_closed"],
    register_signer: ["snacc/signer_added"],
    splice_failed: [],
  };
  for (const [name, want] of Object.entries(expected)) {
    const got = events(name);
    assert.deepEqual(names(name), want, name);
    assert.equal(got.malformed, 0, `${name}: no malformed lines`);
  }
});

test("extractEvents: divide (real tx) row fields", () => {
  const { events: rows } = events("divide");
  const row = rows.find((r) => r.event === "strain_divided");
  assert.ok(row);
  assert.equal(row.tx_hash, "GVwhXD6kYyb9qDe2nDZMB6RUgsK5FqqTN51kVuYgnYWf");
  assert.equal(row.signer_id, CONTRACT);
  assert.equal(row.standard, "snacc");
  assert.equal(row.version, "1.0.0");
  assert.equal(row.log_index, 1); // atp_spent is log 0 of the same receipt
  assert.equal(row.block_height, 276920000);
  assert.equal(row.block_time, "2026-11-09T12:28:00.000Z");
  assert.equal(row.data["parent_id"], 1);
  assert.equal(row.data["child_id"], 6);
  assert.equal(row.data["child_generation"], 3);
  assert.equal(row.data["child_balance"], "434463694500699999997225");
  // (receipt_id, log_index) is unique across the whole tx
  assert.equal(new Set(rows.map((r) => `${r.receipt_id}:${r.log_index}`)).size, rows.length);
});

test("extractEvents: the other lineage / death / feed events carry the ids and exact amounts the views need", () => {
  const one = (name: string, event: string) => {
    const r = events(name).events.find((e) => e.event === event);
    assert.ok(r, `${name}/${event}`);
    return r;
  };
  const splice = one("splice", "strains_spliced");
  assert.equal(splice.data["dominant_id"], 5);
  assert.equal(splice.data["absorbed_id"], 1);
  assert.equal(splice.data["merger_tax"], "10861592362517499999930");

  const hostile = one("hostile", "hostile_takeover_spliced");
  assert.equal(hostile.signer_id, "x207-demo-buyer.testnet");
  assert.equal(hostile.data["raider_id"], 4);
  assert.equal(hostile.data["target_id"], 7);
  assert.equal(hostile.data["payment"], "46000000000000000000000");

  const adopt = one("adopt", "strain_adopted");
  assert.equal(adopt.data["target_id"], 9);
  assert.equal(adopt.data["adopter"], CONTRACT);
  assert.equal(adopt.data["raider_strain_id"], 8);

  const harvest = one("harvest", "strain_liquidated");
  assert.equal(harvest.data["target_id"], 9);
  assert.equal(harvest.data["liquidator"], CONTRACT);
  assert.equal(harvest.data["bounty"], "4000000000000000000000");

  const fed = one("feed", "fed");
  assert.equal(fed.data["strain_id"], 10);
  assert.equal(fed.data["effective_fee"], "42416000000000000000000");
  assert.equal(fed.data["dormant"], false);

  const created = one("incubate", "strain_created");
  assert.equal(created.data["strain_id"], 10);
  assert.equal(created.data["owner_id"], CONTRACT);
  assert.equal(created.data["initial_snacc_stake"], "250000000000000000000000");

  const nft = one("nft_transfer", "nft_transfer");
  assert.equal(nft.standard, "nep171");
  assert.deepEqual(nft.data["token_ids"], ["4"]);
  assert.equal(nft.data["new_owner_id"], "x207-demo-buyer.testnet");
});

test("extractEvents ignores logs of failed receipts and of receipts executed by other accounts", () => {
  const failed = JSON.parse(JSON.stringify(txFixture("divide").result)) as Record<string, unknown>;
  for (const ro of failed["receipts_outcome"] as Array<{ outcome: { status: unknown } }>) ro.outcome.status = { Failure: { ActionError: { index: 0, kind: "FunctionCallError" } } };
  assert.deepEqual(extractEvents(failed, ctxFor("divide"), CONTRACT).events, []);

  const other = extractEvents(txFixture("divide").result, ctxFor("divide"), "other.testnet");
  assert.deepEqual(other.events, []);

  assert.deepEqual(extractEvents(null, ctxFor("divide"), CONTRACT), { events: [], malformed: 0 });
  assert.deepEqual(extractEvents({ receipts_outcome: "x" }, ctxFor("divide"), CONTRACT), { events: [], malformed: 0 });
});

// ---------------------------------------------------------------------------------------------
// Market contract (snacc-market.testnet, standard snacc_market) - real txs from 2026-11-13
//   market_list 6JF7XvVD... (nft_transfer_call on the Snacc contract -> listed), market_buy 86HXrAAQ... (buy -> sold),
//   market_delist 8Q3p33jw... (delist -> delisted)
// ---------------------------------------------------------------------------------------------
const MARKET = "snacc-market.testnet";
const SOURCES = { snacc: CONTRACT, market: MARKET };
const marketEvents = (name: string) => extractEvents(txFixture(name).result, ctxFor(name), SOURCES);

test("extractEvents: market txs carry the market event AND the Snacc contract's nep171 transfer, in one tx", () => {
  const want: Record<string, string[]> = {
    market_list: ["nep171/nft_transfer", "snacc_market/listed"],
    market_buy: ["nep171/nft_transfer", "snacc_market/sold"],
    market_delist: ["nep171/nft_transfer", "snacc_market/delisted"],
  };
  for (const [name, w] of Object.entries(want)) {
    const got = marketEvents(name);
    assert.deepEqual(got.events.map((e) => `${e.standard}/${e.event}`), w, name);
    assert.equal(got.malformed, 0);
    assert.equal(new Set(got.events.map((e) => `${e.receipt_id}:${e.log_index}`)).size, got.events.length);
  }
  const sold = marketEvents("market_buy").events.find((e) => e.event === "sold");
  assert.ok(sold);
  assert.equal(sold.signer_id, "snacc-starter.testnet"); // the buyer signed the tx
  assert.deepEqual(sold.data, { token_id: "11", seller_id: CONTRACT, buyer_id: "snacc-starter.testnet", price: "100000000000000000000000" });
  const sale = marketEvents("market_buy").events.find((e) => e.standard === "nep171");
  assert.equal(sale?.data["new_owner_id"], "snacc-starter.testnet");
  assert.equal(sale?.data["memo"], "snacc_market sale");
  const listed = marketEvents("market_list").events.find((e) => e.event === "listed");
  assert.equal(listed?.data["listed_at"], "1794582012496400147");
  const delisted = marketEvents("market_delist").events.find((e) => e.event === "delisted");
  assert.equal(delisted?.data["reason"], "seller");
});

test("extractEvents: without a market account only the Snacc contract's events are taken; each contract speaks only for its own standard", () => {
  assert.deepEqual(names("market_buy"), ["nep171/nft_transfer"]);
  assert.deepEqual(extractEvents(txFixture("market_buy").result, ctxFor("market_buy"), { snacc: CONTRACT, market: null }).events.map((e) => e.event), ["nft_transfer"]);
  // a snacc_market line logged by the Snacc contract, and a nep171 line logged by the market, are both ignored
  const tx = JSON.parse(JSON.stringify(txFixture("market_buy").result)) as { receipts_outcome: Array<{ outcome: { logs: string[]; executor_id: string } }> };
  for (const ro of tx.receipts_outcome) {
    if (ro.outcome.logs.length === 0) continue;
    const other = ro.outcome.executor_id === CONTRACT ? tx.receipts_outcome.find((r) => r.outcome.executor_id === MARKET) : tx.receipts_outcome.find((r) => r.outcome.executor_id === CONTRACT);
    assert.ok(other);
    ro.outcome.logs = [...other.outcome.logs];
  }
  assert.deepEqual(extractEvents(tx, ctxFor("market_buy"), SOURCES).events, []);
});

test("isWellFormed: market events need a decimal token_id, seller_id and integer prices", () => {
  const mk = (event: string, data: Record<string, unknown>) => ({ standard: "snacc_market", version: "1.0.0", event, data });
  assert.equal(isWellFormed(mk("listed", { token_id: "11", seller_id: "a.testnet", price: "100", listed_at: "5" })), true);
  assert.equal(isWellFormed(mk("listed", { token_id: "11", seller_id: "a.testnet" })), false);
  assert.equal(isWellFormed(mk("listed", { token_id: 11, seller_id: "a.testnet", price: "100" })), false);
  assert.equal(isWellFormed(mk("sold", { token_id: "11", seller_id: "a.testnet", price: "100" })), false); // buyer missing
  assert.equal(isWellFormed(mk("sold", { token_id: "11", seller_id: "a.testnet", buyer_id: "b.testnet", price: "100" })), true);
  assert.equal(isWellFormed(mk("price_updated", { token_id: "11", seller_id: "a", old_price: "1", new_price: "2" })), true);
  assert.equal(isWellFormed(mk("price_updated", { token_id: "11", seller_id: "a", old_price: "1" })), false);
  assert.equal(isWellFormed(mk("delisted", { token_id: "11", seller_id: "a", reason: "seller" })), true);
  assert.equal(isWellFormed(mk("a_future_market_event", { whatever: 1 })), true);
});

test("resolveMarketId: default, override, and off switch", () => {
  assert.equal(resolveMarketId(() => undefined), "snacc-market.testnet");
  assert.equal(resolveMarketId((k) => (k === "SNACC_MARKET_CONTRACT_ID" ? " m2.testnet " : undefined)), "m2.testnet");
  for (const off of ["none", "OFF", "-"]) assert.equal(resolveMarketId(() => off), null);
});

test("classifyTx for the market listing: its `new` is not a state reset, buy / delist are fetched", () => {
  const base: ListedTx = { hash: "m1", signerId: MARKET, receiverId: MARKET, blockTimestamp: "1794581904297971728", blockHeight: 1, ok: true, actions: [{ action: "DEPLOY_CONTRACT", method: null }, { action: "FUNCTION_CALL", method: "new" }] };
  assert.deepEqual(classifyTx(base, MARKET, false), { kind: "fetch" });
  assert.deepEqual(classifyTx(base, MARKET, true), { kind: "reset", method: "new" });
  const buy: ListedTx = { ...base, hash: "m2", signerId: "snacc-starter.testnet", actions: [{ action: "FUNCTION_CALL", method: "buy" }] };
  assert.deepEqual(classifyTx(buy, MARKET, false), { kind: "fetch" });
  assert.deepEqual(classifyTx(buy, CONTRACT, true), { kind: "skip", reason: "other_receiver" }); // not in the Snacc walk
});

test("extractEvents counts malformed EVENT_JSON lines and keeps log_index = position in the logs array", () => {
  const tx = JSON.parse(JSON.stringify(txFixture("feed").result)) as { receipts_outcome: Array<{ outcome: { logs: string[]; executor_id: string } }> };
  const ro = tx.receipts_outcome.find((r) => r.outcome.executor_id === CONTRACT && r.outcome.logs.length > 0);
  assert.ok(ro);
  ro.outcome.logs = [
    "plain log",
    'EVENT_JSON:{"standard":"snacc","version":"1.0.0","event":"strain_divided","data":[{"kind":"strain_divided","parent_id":"x"}]}',
    "EVENT_JSON:{broken",
    ...ro.outcome.logs,
  ];
  const got = extractEvents(tx, ctxFor("feed"), CONTRACT);
  assert.equal(got.malformed, 2);
  assert.deepEqual(got.events.map((e) => [e.event, e.log_index]), [["dividend_inflow", 3], ["fed", 4]]);
});

test("stateResetRow keys the pseudo event by the tx hash", () => {
  const tx: ListedTx = {
    hash: "G4fLRtP7RiPAWueNqHkgkao7NJKAmF3WtLks9jFwmF25",
    signerId: CONTRACT,
    receiverId: CONTRACT,
    blockTimestamp: "1794226785653428884",
    blockHeight: 276919939,
    ok: true,
    actions: [{ action: "FUNCTION_CALL", method: "migrate" }],
  };
  const row = stateResetRow(tx, "migrate");
  assert.equal(row.receipt_id, tx.hash);
  assert.equal(row.log_index, 0);
  assert.equal(row.standard, "snacc-index");
  assert.equal(row.event, "state_reset");
  assert.deepEqual(row.data, { method: "migrate" });
  assert.equal(row.block_height, 276919939);
  assert.equal(row.block_time, nsToIso("1794226785653428884"));
  assert.equal(row.block_time, "2026-11-09T12:19:45.653Z");
});

// ---------------------------------------------------------------------------------------------
// NearBlocks v3 listing
// ---------------------------------------------------------------------------------------------

test("nearBlocksTxnsUrl: v3 path with limit and an opaque cursor", () => {
  assert.equal(nearBlocksTxnsUrl("https://api-testnet.nearblocks.io", CONTRACT, 100, null), "https://api-testnet.nearblocks.io/v3/accounts/snacc-v001.testnet/txns?limit=100");
  const u = new URL(nearBlocksTxnsUrl("https://api-testnet.nearblocks.io/", CONTRACT, 25, "eyJ4Ijoi=="));
  assert.equal(u.pathname, "/v3/accounts/snacc-v001.testnet/txns");
  assert.equal(u.searchParams.get("limit"), "25");
  assert.equal(u.searchParams.get("next"), "eyJ4Ijoi==");
});

const page1 = parseNearBlocksPage(readJson("nearblocks-v3-txns-page1.json"));
const lastPage = parseNearBlocksPage(readJson("nearblocks-v3-txns-last-page.json"));

test("parseNearBlocksPage: real v3 pages (newest first, cursor on all but the last)", () => {
  assert.equal(page1.txs.length, 100);
  assert.ok(page1.next && page1.next.length > 10);
  assert.equal(lastPage.txs.length, 62);
  assert.equal(lastPage.next, null);
  // newest first, nanosecond timestamps kept as text
  for (const p of [page1, lastPage]) {
    for (let i = 1; i < p.txs.length; i++) assert.ok(BigInt((p.txs[i - 1] as ListedTx).blockTimestamp) >= BigInt((p.txs[i] as ListedTx).blockTimestamp));
  }
  assert.ok(BigInt((page1.txs[page1.txs.length - 1] as ListedTx).blockTimestamp) > BigInt((lastPage.txs[0] as ListedTx).blockTimestamp));
  const hostile = page1.txs.find((t) => t.hash === "4o4qwoGZtR7HE5E3VnjQZpXwDicpa9QVBzXHS1YP2v4f");
  assert.ok(hostile);
  assert.equal(hostile.signerId, "x207-demo-buyer.testnet");
  assert.equal(hostile.receiverId, CONTRACT);
  assert.equal(hostile.ok, true);
  assert.deepEqual(hostile.actions, [{ action: "FUNCTION_CALL", method: "hostile_takeover_splice" }]);
  assert.equal(hostile.blockHeight, 276920272);
});

test("parseNearBlocksPage: error envelope, wrong shape and malformed rows", () => {
  assert.throws(() => parseNearBlocksPage({ data: null, errors: [{ message: "order: only desc is supported." }] }), NearBlocksError);
  assert.throws(() => parseNearBlocksPage("html"), NearBlocksError);
  assert.throws(() => parseNearBlocksPage({ txns: [] }), NearBlocksError);
  const p = parseNearBlocksPage({
    data: [
      { transaction_hash: "A", signer_account_id: "s", receiver_account_id: "r", block_timestamp: "1794226785653428884", block: { block_height: "5" }, outcomes: { status: false }, actions: [{ action: "TRANSFER", method: null }] },
      { transaction_hash: "B", signer_account_id: "s", receiver_account_id: "r", block_timestamp: "soon", block: { block_height: "5" } },
      { signer_account_id: "s" },
      "nope",
    ],
    meta: { next_page: "" },
  });
  assert.equal(p.txs.length, 1);
  assert.equal(p.txs[0]?.ok, false);
  assert.equal(p.next, null);
});

test("classifyTx on the real listing: failed and non-call txs are skipped, migrate is a reset, calls are fetched", () => {
  const byHash = (h: string) => {
    const t = page1.txs.find((x) => x.hash === h);
    assert.ok(t, h);
    return t;
  };
  assert.deepEqual(classifyTx(byHash("G4fLRtP7RiPAWueNqHkgkao7NJKAmF3WtLks9jFwmF25"), CONTRACT), { kind: "reset", method: "migrate" });
  assert.deepEqual(classifyTx(byHash("D7QUnBn2jRBgpL3WufyToyEw3XNzRtoD7jj1M52mGvNZ"), CONTRACT), { kind: "skip", reason: "failed" }); // migrate by a stranger: failed
  assert.deepEqual(classifyTx(byHash("8ydFE4XjpwYbnrPUULjvtbqbqwU4PYSJ3rJyyVimu4TL"), CONTRACT), { kind: "skip", reason: "no_function_call" }); // DEPLOY_CONTRACT
  assert.deepEqual(classifyTx(byHash("4o4qwoGZtR7HE5E3VnjQZpXwDicpa9QVBzXHS1YP2v4f"), CONTRACT), { kind: "fetch" });
  assert.deepEqual(classifyTx(byHash("81vVZ5cu8ofeKtBB3WskHjjjWU8mmQQ9wxpAYb3hkZgi"), CONTRACT), { kind: "fetch" });
  assert.deepEqual(classifyTx(byHash("81vVZ5cu8ofeKtBB3WskHjjjWU8mmQQ9wxpAYb3hkZgi"), "someone-else.testnet"), { kind: "skip", reason: "other_receiver" });
  const kinds = new Map<string, number>();
  for (const t of [...page1.txs, ...lastPage.txs]) {
    const p = classifyTx(t, CONTRACT);
    const k = p.kind === "skip" ? `skip:${p.reason}` : p.kind;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  // 162 listed txs: 1 + 1 successful migrate/new, the rest split between failed, deploy/transfer and calls
  assert.equal([...kinds.values()].reduce((a, b) => a + b, 0), 162);
  assert.ok((kinds.get("reset") ?? 0) >= 1);
  assert.ok((kinds.get("fetch") ?? 0) > 60);
  assert.ok((kinds.get("skip:failed") ?? 0) > 10);
});

// ---------------------------------------------------------------------------------------------
// fetchTxOutcome: which node is asked first
// ---------------------------------------------------------------------------------------------

type RpcCall = { url: string; method: string };
function rpcWith(handler: (url: string) => unknown): { rpc: NearRpc; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: (JSON.parse(init.body as string) as { method: string }).method });
    return new Response(JSON.stringify(handler(url)));
  }) as unknown as typeof fetch;
  return { rpc: new NearRpc({ urls: ["https://regular.test"], archivalUrl: "https://archival.test", fetchFn }), calls };
}
const timeoutErr = { jsonrpc: "2.0", id: "snacc", error: { name: "HANDLER_ERROR", cause: { name: "TIMEOUT_ERROR", info: { cause: "NOT_OBSERVED" } }, code: -32000, message: "Server error", data: "Timeout" } };
const divideListed: ListedTx = {
  hash: "GVwhXD6kYyb9qDe2nDZMB6RUgsK5FqqTN51kVuYgnYWf",
  signerId: CONTRACT,
  receiverId: CONTRACT,
  blockTimestamp: "1794226785653428884", // 2026-11-09
  blockHeight: 276920104,
  ok: true,
  actions: [{ action: "FUNCTION_CALL", method: "divide_strain" }],
};
const divideResult = { jsonrpc: "2.0", id: "snacc", result: txFixture("divide").result };

test("fetchTxOutcome: an old tx goes to the archival node first (no 10 s wait on the regular node)", async () => {
  const { rpc, calls } = rpcWith((url) => (url === "https://archival.test" ? divideResult : timeoutErr));
  const now = Number(BigInt(divideListed.blockTimestamp) / 1_000_000n) + ARCHIVAL_AGE_MS + 60_000;
  const r = await fetchTxOutcome(rpc, divideListed, now);
  assert.deepEqual(calls.map((c) => c.url), ["https://archival.test"]);
  assert.equal(((r as { transaction: { hash: string } }).transaction).hash, divideListed.hash);
});

test("fetchTxOutcome: a recent tx goes to the regular node first, falls back to archival on TIMEOUT_ERROR / UNKNOWN_TRANSACTION", async () => {
  const now = Number(BigInt(divideListed.blockTimestamp) / 1_000_000n) + 60_000;
  const first = rpcWith(() => divideResult);
  await fetchTxOutcome(first.rpc, divideListed, now);
  assert.deepEqual(first.calls.map((c) => c.url), ["https://regular.test"]);

  const second = rpcWith((url) => (url === "https://archival.test" ? divideResult : timeoutErr));
  await fetchTxOutcome(second.rpc, divideListed, now);
  assert.deepEqual(second.calls.map((c) => c.url), ["https://regular.test", "https://archival.test"]);

  const unknown = { jsonrpc: "2.0", id: "snacc", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION", info: {} }, code: -32000, message: "Server error", data: "x" } };
  const third = rpcWith((url) => (url === "https://archival.test" ? divideResult : unknown));
  await fetchTxOutcome(third.rpc, divideListed, now);
  assert.deepEqual(third.calls.map((c) => c.url), ["https://regular.test", "https://archival.test"]);
});

test("fetchTxOutcome: an old tx the archival node cannot serve falls back to the regular nodes; both failing throws", async () => {
  const now = Number(BigInt(divideListed.blockTimestamp) / 1_000_000n) + ARCHIVAL_AGE_MS + 60_000;
  const a = rpcWith((url) => (url === "https://regular.test" ? divideResult : { jsonrpc: "2.0", id: "snacc", error: { name: "INTERNAL_ERROR", cause: { name: "INTERNAL_ERROR", info: {} }, code: -32000, message: "boom" } }));
  await fetchTxOutcome(a.rpc, divideListed, now);
  assert.deepEqual(a.calls.map((c) => c.url), ["https://archival.test", "https://regular.test"]);
  const b = rpcWith(() => timeoutErr);
  await assert.rejects(fetchTxOutcome(b.rpc, divideListed, now));
});

test("fetchTxOutcome: refuses an answer for another transaction", async () => {
  const { rpc } = rpcWith(() => divideResult);
  await assert.rejects(fetchTxOutcome(rpc, { ...divideListed, hash: "SomeOtherHash11111111111111111111111111111111" }, Date.now()), /not transaction/);
});

// ---------------------------------------------------------------------------------------------
// runIndex: cursor / batching
// ---------------------------------------------------------------------------------------------

const NS = 1_000_000_000n;
const T0 = 1794200000n * NS; // a fixed base timestamp (ns)
function tx(i: number, opts: Partial<ListedTx> = {}): ListedTx {
  return {
    hash: `tx${String(i).padStart(4, "0")}`,
    signerId: CONTRACT,
    receiverId: CONTRACT,
    blockTimestamp: String(T0 + BigInt(i) * 1200n * NS), // 20 minutes apart (wider than the 5 min lookback); higher i = newer
    blockHeight: 1000 + i,
    ok: true,
    actions: [{ action: "FUNCTION_CALL", method: "feed_strain" }],
    ...opts,
  };
}
/** A fake NearBlocks: txs sorted newest first, served in pages with opaque cursors "p<offset>". */
function fakeListing(all: ListedTx[], pageSize: number, log: Array<string | null> = []): (cursor: string | null) => Promise<ListPage> {
  const sorted = [...all].sort((a, b) => (BigInt(b.blockTimestamp) > BigInt(a.blockTimestamp) ? 1 : -1));
  return async (cursor) => {
    log.push(cursor);
    const off = cursor ? Number(cursor.slice(1)) : 0;
    const txs = sorted.slice(off, off + pageSize);
    return { txs, next: off + pageSize < sorted.length ? `p${off + pageSize}` : null };
  };
}
interface Harness {
  deps: IndexDeps;
  processed: Array<{ hash: string; kind: string }>;
  now: { ms: number };
  failing: Set<string>;
  listCalls: Array<string | null>;
}
function harness(all: ListedTx[], pageSize = 10): Harness {
  const listCalls: Array<string | null> = [];
  const processed: Harness["processed"] = [];
  const now = { ms: 1_000_000 };
  const failing = new Set<string>();
  const deps: IndexDeps = {
    contractId: CONTRACT,
    listPage: fakeListing(all, pageSize, listCalls),
    nowMs: () => now.ms,
    async processTx(t: ListedTx, plan: Exclude<TxPlan, { kind: "skip" }>) {
      if (failing.has(t.hash)) throw new Error(`rpc down for ${t.hash}`);
      processed.push({ hash: t.hash, kind: plan.kind });
      return { events: plan.kind === "fetch" ? 2 : 0, malformed: 0 };
    },
  };
  return { deps, processed, now, failing, listCalls };
}
const wide = (over: Partial<IndexLimits> = {}): IndexLimits => ({ maxTxs: 1000, maxPages: 100, deadlineMs: Number.MAX_SAFE_INTEGER, ...over });

test("runIndex: the first walk reaches the end of the listing and sets the head to the newest tx", async () => {
  const all = Array.from({ length: 25 }, (_, i) => tx(i + 1));
  const h = harness(all, 10);
  const { state, counts } = await runIndex(emptyState(), h.deps, wide());
  assert.equal(counts.pages, 3);
  assert.equal(counts.fetched, 25);
  assert.equal(counts.events, 50);
  assert.equal(counts.more, false);
  assert.equal(state.walk, null);
  assert.equal(state.headTs, tx(25).blockTimestamp);
  assert.equal(new Set(h.processed.map((p) => p.hash)).size, 25);
  assert.deepEqual(h.listCalls, [null, "p10", "p20"]);
});

test("runIndex: skips failed / non-call txs without fetching and routes migrate to a reset, never fetching it", async () => {
  const all = [
    tx(1),
    tx(2, { ok: false }),
    tx(3, { actions: [{ action: "DEPLOY_CONTRACT", method: null }] }),
    tx(4, { actions: [{ action: "FUNCTION_CALL", method: "migrate" }] }),
    tx(5, { receiverId: "other.testnet" }),
    tx(6),
  ];
  const h = harness(all, 10);
  const { counts } = await runIndex(emptyState(), h.deps, wide());
  assert.deepEqual(h.processed.map((p) => `${p.hash}:${p.kind}`).sort(), ["tx0001:fetch", "tx0004:reset", "tx0006:fetch"]);
  assert.equal(counts.skipped, 3);
  assert.equal(counts.resets, 1);
  assert.equal(counts.fetched, 2);
});

test("runIndex for the market account: `new` / `migrate` are fetched like any call (only the Snacc contract resets the state)", async () => {
  const all = [tx(1, { receiverId: "snacc-market.testnet", actions: [{ action: "FUNCTION_CALL", method: "new" }] }), tx(2, { receiverId: "snacc-market.testnet", actions: [{ action: "FUNCTION_CALL", method: "buy" }] })];
  const h = harness(all, 10);
  h.deps.contractId = "snacc-market.testnet";
  h.deps.resetsState = false;
  const { counts } = await runIndex(emptyState(), h.deps, wide());
  assert.deepEqual(h.processed.map((p) => `${p.hash}:${p.kind}`).sort(), ["tx0001:fetch", "tx0002:fetch"]);
  assert.equal(counts.resets, 0);
});

test("runIndex: the tx cap stops mid-page, stores where to resume, and later runs finish without gaps", async () => {
  const all = Array.from({ length: 25 }, (_, i) => tx(i + 1));
  const h = harness(all, 10);
  let state: IndexState = emptyState();
  const runs: number[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await runIndex(state, h.deps, wide({ maxTxs: 7 }));
    state = r.state;
    runs.push(r.counts.fetched);
    if (!r.counts.more) break;
    assert.ok(state.walk, "an interrupted walk must be stored");
    assert.equal(state.headTs, "0", "the head only advances when the walk completes");
  }
  assert.deepEqual(runs, [7, 7, 7, 4]);
  assert.equal(state.walk, null);
  assert.equal(state.headTs, tx(25).blockTimestamp);
  assert.deepEqual([...new Set(h.processed.map((p) => p.hash))].sort(), all.map((t) => t.hash).sort());
  assert.equal(h.processed.length, 25, "no tx processed twice (no ties in this listing)");
});

test("runIndex: the page cap stores the next cursor and resumes from it", async () => {
  const all = Array.from({ length: 25 }, (_, i) => tx(i + 1));
  const h = harness(all, 10);
  const a = await runIndex(emptyState(), h.deps, wide({ maxPages: 1 }));
  assert.equal(a.counts.pages, 1);
  assert.equal(a.counts.more, true);
  assert.equal(a.state.walk?.cursor, "p10");
  assert.equal(a.state.headTs, "0");
  const b = await runIndex(a.state, h.deps, wide({ maxPages: 5 }));
  assert.deepEqual(h.listCalls, [null, "p10", "p20"]);
  assert.equal(b.counts.more, false);
  assert.equal(b.state.headTs, tx(25).blockTimestamp);
  assert.equal(new Set(h.processed.map((p) => p.hash)).size, 25);
});

test("runIndex: once caught up, a run lists one page, processes only the new txs, and stops at the old head", async () => {
  const old = Array.from({ length: 25 }, (_, i) => tx(i + 1));
  const first = await runIndex(emptyState(), harness(old, 10).deps, wide());
  const h = harness([...old, tx(26), tx(27)], 10);
  const { state, counts } = await runIndex(first.state, h.deps, wide());
  assert.equal(counts.pages, 1);
  assert.deepEqual(h.processed.map((p) => p.hash).sort(), ["tx0026", "tx0027"]);
  assert.equal(counts.duplicates, 1, "the old head tx is inside the lookback window and already seen");
  assert.equal(state.headTs, tx(27).blockTimestamp);
  // and a run with nothing new does no fetch at all
  const idle = harness([...old, tx(26), tx(27)], 10);
  const again = await runIndex(state, idle.deps, wide());
  assert.equal(idle.processed.length, 0);
  assert.equal(again.counts.pages, 1);
  assert.equal(again.state.headTs, tx(27).blockTimestamp);
});

test("runIndex: a tx NearBlocks indexed late (older than the head but inside the lookback window) is still picked up", async () => {
  const base = Array.from({ length: 25 }, (_, i) => tx(i + 1));
  const first = await runIndex(emptyState(), harness(base, 10).deps, wide());
  // tx 30 is newer; tx 24.5 shows up late (between tx 24 and tx 25, ~5 s before the old head); tx 5 is far older and was never missed
  const late = tx(0, { hash: "late0001", blockTimestamp: String(BigInt(tx(25).blockTimestamp) - 5n * NS) });
  const h = harness([...base, late, tx(30)], 10);
  const { counts, state } = await runIndex(first.state, h.deps, wide());
  assert.deepEqual(h.processed.map((p) => p.hash).sort(), ["late0001", "tx0030"]);
  assert.ok(counts.duplicates >= 1, "txs already seen inside the window are skipped, not refetched");
  assert.equal(state.headTs, tx(30).blockTimestamp);
  // the walk stops at head - lookback: txs older than that are not listed again (one page was enough)
  const floorTs = BigInt(first.state.headTs) - LOOKBACK_NS;
  assert.deepEqual(h.listCalls, [null]);
  assert.ok(BigInt(tx(24).blockTimestamp) < floorTs);
});

test("runIndex: a failing tx goes to the retry list without blocking the walk, is retried first, and is dropped to dead after the attempt limit", async () => {
  const all = Array.from({ length: 12 }, (_, i) => tx(i + 1));
  const h = harness(all, 10);
  h.failing.add("tx0005");
  const a = await runIndex(emptyState(), h.deps, wide());
  assert.equal(a.counts.errors, 1);
  assert.equal(a.counts.fetched, 11);
  assert.equal(a.state.retry.length, 1);
  assert.equal(a.state.retry[0]?.attempts, 1);
  assert.match(a.state.retry[0]?.lastError ?? "", /rpc down for tx0005/);
  assert.equal(a.state.headTs, tx(12).blockTimestamp, "the walk still completed");

  // the node comes back: the retry is processed first and cleared
  h.failing.clear();
  const b = await runIndex(a.state, h.deps, wide());
  assert.equal(b.counts.retried, 1);
  assert.equal(b.state.retry.length, 0);
  assert.equal(h.processed.filter((p) => p.hash === "tx0005").length, 1);

  // a tx that never works ends in `dead` after MAX_RETRY_ATTEMPTS
  const h2 = harness(all, 10);
  h2.failing.add("tx0005");
  let state = (await runIndex(emptyState(), h2.deps, wide())).state;
  for (let i = 1; i < MAX_RETRY_ATTEMPTS; i++) state = (await runIndex(state, h2.deps, wide())).state;
  assert.equal(state.retry.length, 0);
  assert.equal(state.dead.length, 1);
  assert.equal(state.dead[0]?.tx.hash, "tx0005");
  assert.equal(state.dead[0]?.attempts, MAX_RETRY_ATTEMPTS);
});

test("runIndex: a NearBlocks failure rejects and leaves the stored state untouched", async () => {
  const stored: IndexState = { headTs: String(T0), seen: [["tx0001", String(T0)]], walk: null, retry: [], dead: [] };
  const before = JSON.stringify(stored);
  const h = harness([], 10);
  h.deps.listPage = async () => {
    throw new NearBlocksError("nearblocks: HTTP 429", 429);
  };
  await assert.rejects(runIndex(stored, h.deps, wide()), NearBlocksError);
  assert.equal(JSON.stringify(stored), before);
});

test("runIndex: an empty listing changes nothing; an exhausted deadline starts no work", async () => {
  const empty = await runIndex(emptyState(), harness([], 10).deps, wide());
  assert.deepEqual(empty.state, emptyState());
  assert.equal(empty.counts.pages, 1);

  const h = harness([tx(1), tx(2)], 10);
  h.now.ms = 5_000;
  const late = await runIndex(emptyState(), h.deps, wide({ deadlineMs: 4_000 }));
  assert.equal(late.counts.more, true);
  assert.equal(late.counts.pages, 0);
  assert.equal(h.processed.length, 0);
});

test("runIndex: with the real listing fixtures the whole contract history is planned once", async () => {
  const pages = [page1, lastPage];
  const processed: string[] = [];
  const deps: IndexDeps = {
    contractId: CONTRACT,
    listPage: async (cursor) => {
      const p = cursor === null ? page1 : lastPage;
      return { txs: p.txs, next: cursor === null ? "second" : null };
    },
    nowMs: () => 0,
    async processTx(t) {
      processed.push(t.hash);
      return { events: 1, malformed: 0 };
    },
  };
  const { state, counts } = await runIndex(emptyState(), deps, wide());
  const expected = pages.flatMap((p) => p.txs).filter((t) => classifyTx(t, CONTRACT).kind !== "skip");
  assert.equal(processed.length, expected.length);
  assert.equal(new Set(processed).size, expected.length);
  assert.equal(counts.fetched + counts.resets, expected.length);
  assert.equal(state.headTs, (page1.txs[0] as ListedTx).blockTimestamp);
  assert.equal(state.walk, null);
});

test("normalizeState tolerates a missing or damaged row and round-trips a real one", () => {
  assert.deepEqual(normalizeState(null), emptyState());
  assert.deepEqual(normalizeState({ head_ts: "oops", seen: "x", walk: 5, retry: null, dead: [{ nope: 1 }] }), emptyState());
  const s: IndexState = {
    headTs: "1794226785653428884",
    seen: [["tx0001", "1794226785653428884"]],
    walk: { headTs: "1794226785653428884", cursor: "p10", resumeTs: "1794226785653428000", seen: [["tx0002", "1794226785653428000"]] },
    retry: [{ tx: tx(3), attempts: 2, lastError: "boom" }],
    dead: [],
  };
  const row = { head_ts: s.headTs, seen: s.seen, walk: s.walk, retry: s.retry, dead: s.dead };
  assert.deepEqual(normalizeState(JSON.parse(JSON.stringify(row)) as Record<string, unknown>), s);
  assert.notEqual(cloneState(s), s);
});

// ---------------------------------------------------------------------------------------------
// The migration text stays in step with the indexer
// ---------------------------------------------------------------------------------------------

test("migration 0006: names, schedule, and the event names the views read", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261113000006_snacc_chain_index.sql", import.meta.url), "utf8");
  // every table / view the migration creates ends in _snacc
  const created = [...sql.matchAll(/create (?:or replace )?(?:table|view)(?: if not exists)? public\.(\w+)/g)].map((m) => m[1] as string);
  assert.deepEqual(created.sort(), [
    "chain_events_current_snacc",
    "chain_events_snacc",
    "chain_index_state_snacc",
    "graveyard_snacc",
    "strain_history_snacc",
    "strain_lineage_snacc",
  ]);
  for (const n of created) assert.match(n, /_snacc$/);
  assert.match(sql, /cron\.schedule\(\s*'snacc_chain_index',\s*'\*\/10 \* \* \* \*'/);
  assert.match(sql, /https:\/\/vldhsabgpfxccsljdtye\.supabase\.co\/functions\/v1\/chain-index/);
  assert.match(sql, /'x-cron-secret', \(select decrypted_secret from vault\.decrypted_secrets where name = 'snacc_cron_secret' limit 1\)/);
  // event names as the contract emits them (contracts/snacc/src/lib.rs)
  for (const ev of [
    "strain_divided", "strains_spliced", "hostile_takeover_spliced", "strain_adopted", "strain_liquidated", "strain_created", "fed",
    "extracted", "transmuted", "synthesized", "genome_committed", "genome_mutated", "atp_allocated", "aether_burned_for_dividend",
    "dividend_claimed", "npc_spores_bought", "trait_conjugated", "nft_transfer", "listed", "sold", "delisted", "price_updated",
  ]) {
    assert.ok(sql.includes(`'${ev}'`), `migration reads event ${ev}`);
  }
  assert.ok(sql.includes("'snacc_market'"));
  // one cursor row per indexed account
  assert.match(sql, /create table if not exists public\.chain_index_state_snacc \(\s*account_id text primary key/);
  // the unique key the Edge Function upserts on
  assert.match(sql, /primary key \(receipt_id, log_index\)/);
  // views are security_invoker, tables have RLS and no client writes
  assert.equal((sql.match(/security_invoker = true/g) ?? []).length, 4);
  assert.match(sql, /alter table public\.chain_events_snacc enable row level security/);
  assert.match(sql, /revoke insert, update, delete, truncate on public\.chain_events_snacc from anon, authenticated/);
  assert.match(sql, /revoke all on public\.chain_index_state_snacc from anon, authenticated/);
});
