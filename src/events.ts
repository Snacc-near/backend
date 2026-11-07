/**
 * Ekstraksi event NEP-297 dari log eksekusi (INT-104).
 * Mendukung dua format yang dipancarkan kontrak (lihat sdk/src/events.ts):
 *  - JSON telanjang {"kind": "...", ...}
 *  - EVENT_JSON:{standard:"neardak-event"...} pembungkus baku (VC-010)
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

/** Ambil event dari satu daftar log. Log tanpa JSON event diabaikan. */
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
        // pembungkus NEP-297: { standard, event, data: [ {...} ] }
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
        // log non-JSON — abaikan
      }
    }
  }
  return out;
}

export interface EventStore {
  events: CrucibleEvent[];
  strainsSeen: Map<number, { owner_id: string }>;
  indexerComplete: boolean;
}

export function newEventStore(): EventStore {
  return { events: [], strainsSeen: new Map(), indexerComplete: false };
}

/** Simpan event ke store; catat strain_created untuk list /api/strains. */
export function absorbEvent(store: EventStore, ev: CrucibleEvent): void {
  store.events.push(ev);
  if (ev.kind === "strain_created") {
    const sid = Number(ev.raw["strain_id"]);
    if (Number.isInteger(sid)) {
      store.strainsSeen.set(sid, { owner_id: String(ev.raw["owner_id"] ?? "") });
    }
  }
}

/** Fungsi murni: kumpulkan event dari hasil RPC `chunk` (mudah diuji). */
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
