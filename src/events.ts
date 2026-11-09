/**
 * NEP-297 event extraction from execution logs (INT-104).
 * Supports both formats emitted by the contract (see sdk/src/events.ts):
 *  - Bare JSON {"kind": "...", ...}
 *  - Standard EVENT_JSON:{standard:"neardak-event"...} wrapper (VC-010)
 */

export interface CrucibleEvent {
  kind: string;
  block_height?: number;
  receipt_id?: string;
  raw: Record<string, unknown>;
}

function parseEventObject(obj: unknown): Record<string, unknown> | null {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const kind = rec["kind"] ?? (rec["data"] as Record<string, unknown>)?.["kind"];
  if (typeof kind !== "string" || kind.length === 0) return null;
  return rec;
}

/** Extract events from a single log array. Logs without event JSON are ignored. */
export function extractEventsFromLogs(logs: string[]): CrucibleEvent[] {
  const out: CrucibleEvent[] = [];
  for (const log of logs) {
    let candidates: string[] = [];
    if (log.startsWith("EVENT_JSON:")) {
      candidates = [log.slice("EVENT_JSON:".length)];
    } else {
      const brace = log.indexOf("{");
      if (brace >= 0) candidates = [log.slice(brace)];
    }
    for (const cand of candidates) {
      try {
        const parsed = JSON.parse(cand) as unknown;
        // NEP-297 wrapper: { standard, event, data: [ {...} ] }
        const dataArr = (parsed as Record<string, unknown>)?.["data"];
        if (Array.isArray(dataArr)) {
          for (const item of dataArr) {
            const ev = parseEventObject(item);
            if (ev) out.push({ kind: String(ev["kind"]), raw: ev });
          }
          continue;
        }
        const ev = parseEventObject(parsed);
        if (ev) out.push({ kind: String(ev["kind"]), raw: ev });
      } catch {
        // non-JSON log — ignore
      }
    }
  }
  return out;
}

export interface EventStore {
  events: CrucibleEvent[];
  strainsSeen: Map<number, { owner_id: string }>;
  indexerComplete: boolean;
  /** Events dropped by the memory cap (`MAX_EVENTS`); oldest are evicted first. */
  droppedEvents: number;
}

/** In-memory cap: drop the oldest events beyond this (INT-102 memory bound). */
export const MAX_EVENTS = 5000;

export function newEventStore(): EventStore {
  return { events: [], strainsSeen: new Map(), indexerComplete: false, droppedEvents: 0 };
}

/** Store an event in memory; record strain_created for /api/strains fallback tracking. */
export function absorbEvent(store: EventStore, ev: CrucibleEvent): void {
  store.events.push(ev);
  while (store.events.length > MAX_EVENTS) {
    store.events.shift();
    store.droppedEvents += 1;
  }
  if (ev.kind === "strain_created") {
    const sid = Number(ev.raw["strain_id"]);
    if (Number.isInteger(sid)) {
      store.strainsSeen.set(sid, { owner_id: String(ev.raw["owner_id"] ?? "") });
    }
  }
}

/** Pure function: collect events from an RPC `chunk` result (easy to unit test). */
export function collectEventsFromChunk(chunk: {
  receipts: Array<{ receipt_id: string; outcome: { logs: string[] } }>;
}): CrucibleEvent[] {
  const out: CrucibleEvent[] = [];
  for (const receipt of chunk.receipts) {
    for (const ev of extractEventsFromLogs(receipt.outcome.logs)) {
      ev.receipt_id = receipt.receipt_id;
      out.push(ev);
    }
  }
  return out;
}
