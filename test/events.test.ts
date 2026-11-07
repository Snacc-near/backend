import test from "node:test";
import assert from "node:assert/strict";
import {
  extractEventsFromLogs,
  collectEventsFromChunk,
  absorbEvent,
  newEventStore,
} from "../src/events.js";

test("JSON telanjang kind (format kontrak saat ini)", () => {
  const logs = ['{"kind":"strain_created","strain_id":1,"owner_id":"a.testnet","role_mask":1}'];
  const evs = extractEventsFromLogs(logs);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, "strain_created");
});

test("pembungkus EVENT_JSON NEP-297 (VC-010)", () => {
  const logs = [
    'EVENT_JSON:{"standard":"nep245","version":"1.0.0","event":"extracted","data":[{"kind":"extracted","strain_id":2,"token":"mt:spore-ignis","amount":1,"catalyst_fee":100}]}',
  ];
  const evs = extractEventsFromLogs(logs);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.kind, "extracted");
  assert.equal(evs[0]!.raw["catalyst_fee"], 100);
});

test("log non-event diabaikan tanpa melempar", () => {
  const evs = extractEventsFromLogs(["subaccount_materialized strain_id=1 sub_account_id=s-1.snacc-v001.near", "biasa saja", "{bukan json"]);
  assert.equal(evs.length, 0);
});

test("collectEventsFromChunk mengambil log dari tiap receipt", () => {
  const chunk = {
    receipts: [
      { receipt_id: "r1", outcome: { logs: ['{"kind":"synthesized","strain_id":3}'] } },
      { receipt_id: "r2", outcome: { logs: [] } },
    ],
  };
  const evs = collectEventsFromChunk(chunk);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.receipt_id, "r1");
});

test("absorbEvent mencatat strain_created ke store", () => {
  const store = newEventStore();
  absorbEvent(store, { kind: "strain_created", raw: { strain_id: 1, owner_id: "a.testnet" } });
  absorbEvent(store, { kind: "strain_created", raw: { strain_id: 2, owner_id: "b.testnet" } });
  absorbEvent(store, { kind: "extracted", raw: { strain_id: 1 } });
  assert.equal(store.events.length, 3);
  assert.equal(store.strainsSeen.size, 2);
  assert.equal(store.strainsSeen.get(1)?.owner_id, "a.testnet");
  assert.equal(store.indexerComplete, false);
});
