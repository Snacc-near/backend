import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { NearRpcClient } from "../src/near.js";
import {
  EVALUATE_ACTION,
  EVALUATE_RECIPIENT,
  RATE_TOTAL_PER_DAY,
  RateLimiter,
  evaluateGenome,
  newEvaluateState,
  type EvaluateDeps,
} from "../src/evaluate.js";
import { route, newStore } from "../src/server.js";
import { base58Decode, parseEd25519PublicKey } from "../src/nep413.js";
import { clearExperimentCache } from "../src/oracle/enclave-client.js";

const NOW = 1_800_000_000_000;
const CONTRACT = "snacc-v001.testnet";
const API_KEY = "sk-test-SECRET-key-0123456789abcdef";
const OWNER = "alice.testnet";

// ---- util tes: base58 encode + NEP-413 independen dari src (borsh manual) ----
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58enc(buf: Buffer): string {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
function bstr(s: string): Buffer {
  const b = Buffer.from(s);
  const l = Buffer.alloc(4);
  l.writeUInt32LE(b.length);
  return Buffer.concat([l, b]);
}
function nep413Sign(priv: KeyObject, message: string, nonce: Buffer, recipient: string): string {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  const ser = Buffer.concat([tag, bstr(message), nonce, bstr(recipient), Buffer.from([0])]);
  return edSign(null, createHash("sha256").update(ser).digest(), priv).toString("base64");
}
function newKey(): { priv: KeyObject; pubStr: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return { priv: privateKey, pubStr: `ed25519:${b58enc(x)}` };
}

interface AuthOpts {
  accountId?: string;
  strainId?: number;
  ts?: number;
  recipient?: string;
  key?: { priv: KeyObject; pubStr: string };
  nonce?: Buffer;
  action?: string;
}
function makeAuth(o: AuthOpts = {}) {
  const key = o.key ?? signer;
  const nonce = o.nonce ?? randomBytes(32);
  const message = JSON.stringify({
    action: o.action ?? EVALUATE_ACTION,
    strain_id: o.strainId ?? 5,
    timestamp: o.ts ?? NOW,
  });
  return {
    account_id: o.accountId ?? OWNER,
    public_key: key.pubStr,
    signature: nep413Sign(key.priv, message, nonce, o.recipient ?? EVALUATE_RECIPIENT),
    nonce: nonce.toString("base64"),
    message,
  };
}
const signer = newKey();

// ---- mock RPC ----
interface RpcMock {
  keyPermission?: unknown; // undefined = kunci tidak ada
  keyMissingStyle?: "result" | "jsonrpc";
  strainOwner?: string | null; // null = strain tak ada
  calls: string[];
}
function mockRpc(m: RpcMock): NearRpcClient {
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const { params } = JSON.parse(init.body as string) as { params: Record<string, string> };
    m.calls.push(params["request_type"] === "view_access_key" ? "view_access_key" : String(params["method_name"]));
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", result }));
    if (params["request_type"] === "view_access_key") {
      if (m.keyPermission !== undefined) return ok({ permission: m.keyPermission, nonce: 1, block_height: 1, block_hash: "h" });
      if (m.keyMissingStyle === "jsonrpc") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: "x", error: { code: -32000, message: "Server error", data: "UNKNOWN_ACCESS_KEY" } }));
      }
      return ok({ error: `access key ${params["public_key"]} does not exist while viewing`, logs: [], block_height: 1, block_hash: "h" });
    }
    if (m.strainOwner === null) return ok({ error: "wasm execution failed", logs: [], block_height: 1, block_hash: "h" });
    const strain = { strain_id: 5, owner_id: m.strainOwner ?? OWNER, atp_balance: 1, last_allocate_epoch: 0 };
    return ok({ result: Array.from(Buffer.from(JSON.stringify(strain))), logs: [], block_height: 1, block_hash: "h" });
  }) as unknown as typeof fetch;
  return new NearRpcClient("http://rpc.test", fetchFn, 0);
}
const okRpc = (calls: string[] = []) => mockRpc({ keyPermission: "FullAccess", calls });

// ---- mock NEAR AI Cloud (chat -> signature) ----
interface TeeMock {
  content?: string;
  failChat?: (init: RequestInit) => never;
  urls: string[];
  auths: (string | undefined)[];
}
function mockTee(t: TeeMock) {
  const enclave = generateKeyPairSync("ed25519");
  const pubHex = Buffer.from(enclave.publicKey.export({ format: "jwk" }).x as string, "base64url").toString("hex");
  let signedText = "";
  let sigHex = "";
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    t.urls.push(url);
    t.auths.push((init?.headers as Record<string, string> | undefined)?.["authorization"]);
    if (url.includes("/v1/privacy/")) return new Response("nf", { status: 404 });
    if (url.endsWith("/v1/chat/completions")) {
      if (t.failChat) t.failChat(init as RequestInit);
      const reqSha = createHash("sha256").update(init?.body as string).digest("hex");
      const resText = JSON.stringify({
        id: "chatcmpl-test-1",
        choices: [{ message: { content: t.content ?? JSON.stringify({ efficiency_shift_bps: 120, vitality_bonus: 30, phenotype_trait: "luminous" }) } }],
      });
      const resSha = createHash("sha256").update(resText).digest("hex");
      signedText = `z-ai/glm-5.3-flash:${reqSha}:${resSha}`;
      sigHex = edSign(null, Buffer.from(signedText), enclave.privateKey).toString("hex");
      return new Response(resText, { status: 200 });
    }
    if (url.includes("/v1/signature/")) {
      return new Response(JSON.stringify({ text: signedText, signature: sigHex, signing_address: pubHex, signing_algo: "ed25519" }));
    }
    return new Response("?", { status: 500 });
  };
  return fetchFn;
}

function deps(over: Partial<EvaluateDeps> = {}, tee: TeeMock = { urls: [], auths: [] }): EvaluateDeps {
  return { apiKey: API_KEY, fetchFn: mockTee(tee), now: () => NOW, ...newEvaluateState(), ...over };
}
const body = (auth: unknown, over: Record<string, unknown> = {}) => ({
  strain_id: 5,
  payload_text: "Catalyst bloom by alice.testnet | Ignis-Spore: 3, Lumin-Spore: 2",
  raw_formula: "Ignis-Spore: 3, Lumin-Spore: 2",
  auth,
  ...over,
});
const err = (r: { body: unknown }) => (r.body as { error: string }).error;

test.beforeEach(() => clearExperimentCache());

test("nep413: base58 + parse kunci publik", () => {
  assert.equal(base58Decode("2NEpo7TZRRrLZSi2U")?.toString(), "Hello World!");
  assert.deepEqual([...(base58Decode("1112") as Buffer)], [0, 0, 0, 1]);
  assert.equal(base58Decode("0OIl"), null);
  assert.equal(parseEd25519PublicKey(signer.pubStr)?.length, 32);
  assert.equal(parseEd25519PublicKey("secp256k1:abc"), null);
  assert.equal(parseEd25519PublicKey("ed25519:abc"), null);
});

test("tanpa NEAR_AI_API_KEY -> 503 tee_not_configured, tanpa panggilan RPC/TEE", async () => {
  const calls: string[] = [];
  const tee: TeeMock = { urls: [], auths: [] };
  const r = await evaluateGenome(body(makeAuth()), okRpc(calls), CONTRACT, deps({ apiKey: undefined }, tee));
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { error: "tee_not_configured" });
  assert.equal(calls.length, 0);
  assert.equal(tee.urls.length, 0);
});

test("jalur sukses: 200, bentuk spec, kunci hanya ke cloud-api.near.ai & tak bocor di respons", async () => {
  const calls: string[] = [];
  const tee: TeeMock = { urls: [], auths: [] };
  const r = await evaluateGenome(body(makeAuth()), okRpc(calls), CONTRACT, deps({}, tee));
  assert.equal(r.status, 200);
  const b = r.body as Record<string, any>;
  assert.equal(b["chatId"], "chatcmpl-test-1");
  assert.match(b["signedText"], /^z-ai\/glm-5\.3-flash:[0-9a-f]{64}:[0-9a-f]{64}$/);
  assert.match(b["signatureHex"], /^[0-9a-f]{128}$/);
  assert.match(b["signingAddress"], /^[0-9a-f]{64}$/);
  assert.deepEqual(b["mutation"], { efficiency_shift_bps: 120, vitality_bonus: 30, phenotype_trait: "luminous" });
  // VC-015: raw_response_body = byte respons enclave utuh (hash-nya = bagian terakhir signedText).
  assert.equal(typeof b["raw_response_body"], "string");
  assert.equal(createHash("sha256").update(b["raw_response_body"]).digest("hex"), b["signedText"].split(":")[2]);
  assert.equal(JSON.parse(b["raw_response_body"]).id, "chatcmpl-test-1");
  const rep = b["redactionReport"];
  assert.equal(rep.redaction_mode, "local_deterministic_sha256");
  assert.equal(rep.signature_verified, true);
  assert.match(rep.request_sha256_hex, /^[0-9a-f]{64}$/);
  assert.ok(!rep.payload_terredaksi.includes("alice.testnet"), "akun harus tersensor");
  assert.ok(!rep.payload_terredaksi.includes("Ignis-Spore: 3, Lumin-Spore: 2"), "takaran mentah harus tersembunyi");
  assert.ok(!JSON.stringify(r.body).includes(API_KEY));
  assert.deepEqual(calls.sort(), ["get_strain", "view_access_key"]);
  assert.ok(tee.urls.length >= 2 && tee.urls.every((u) => u.startsWith("https://cloud-api.near.ai/")));
  assert.ok(tee.auths.includes(`Bearer ${API_KEY}`));
});

test("tanda tangan: dimodifikasi / kunci lain / recipient salah -> 401 invalid_signature", async () => {
  const good = makeAuth();
  const tampered = { ...good, message: good.message.replace('"strain_id":5', '"strain_id":5 ') };
  assert.equal(err(await evaluateGenome(body(tampered), okRpc(), CONTRACT, deps())), "invalid_signature");

  const other = newKey();
  const wrongKey = { ...makeAuth(), public_key: other.pubStr };
  assert.equal(err(await evaluateGenome(body(wrongKey), okRpc(), CONTRACT, deps())), "invalid_signature");

  const wrongRecipient = makeAuth({ recipient: "evil-dapp" });
  const r = await evaluateGenome(body(wrongRecipient), okRpc(), CONTRACT, deps());
  assert.equal(r.status, 401);
  assert.equal(err(r), "invalid_signature");

  const junkSig = { ...makeAuth(), signature: Buffer.alloc(64, 1).toString("base64") };
  assert.equal(err(await evaluateGenome(body(junkSig), okRpc(), CONTRACT, deps())), "invalid_signature");
});

test("auth hilang / pesan salah bentuk / strain_id tak cocok / action salah", async () => {
  let r = await evaluateGenome(body(undefined), okRpc(), CONTRACT, deps());
  assert.deepEqual([r.status, err(r)], [401, "auth_required"]);

  const bad = { ...makeAuth(), message: "bukan json" };
  r = await evaluateGenome(body(bad), okRpc(), CONTRACT, deps());
  assert.deepEqual([r.status, err(r)], [401, "invalid_message"]);

  // tanda tangan sah atas strain 6, tetapi request meminta strain 5
  r = await evaluateGenome(body(makeAuth({ strainId: 6 })), okRpc(), CONTRACT, deps());
  assert.deepEqual([r.status, err(r)], [401, "invalid_message"]);

  r = await evaluateGenome(body(makeAuth({ action: "transfer" })), okRpc(), CONTRACT, deps());
  assert.deepEqual([r.status, err(r)], [401, "invalid_message"]);

  r = await evaluateGenome(body(makeAuth(), { strain_id: -1 }), okRpc(), CONTRACT, deps());
  assert.deepEqual([r.status, err(r)], [400, "invalid_request"]);
  r = await evaluateGenome(body(makeAuth(), { payload_text: "" }), okRpc(), CONTRACT, deps());
  assert.deepEqual([r.status, err(r)], [400, "invalid_request"]);
});

test("kedaluwarsa 5 menit; masa depan > 60 dtk ditolak; tepat 5 menit masih lolos", async () => {
  let r = await evaluateGenome(body(makeAuth({ ts: NOW - 5 * 60_000 - 1 })), okRpc(), CONTRACT, deps());
  assert.deepEqual([r.status, err(r)], [401, "signature_expired"]);
  r = await evaluateGenome(body(makeAuth({ ts: NOW + 61_000 })), okRpc(), CONTRACT, deps());
  assert.deepEqual([r.status, err(r)], [401, "signature_expired"]);
  r = await evaluateGenome(body(makeAuth({ ts: NOW - 5 * 60_000 })), okRpc(), CONTRACT, deps());
  assert.equal(r.status, 200);
});

test("nonce tidak boleh dipakai ulang (replay request identik)", async () => {
  const d = deps();
  const auth = makeAuth();
  assert.equal((await evaluateGenome(body(auth), okRpc(), CONTRACT, d)).status, 200);
  const r = await evaluateGenome(body(auth), okRpc(), CONTRACT, d);
  assert.deepEqual([r.status, err(r)], [401, "nonce_reused"]);
});

test("nonce: panjang salah ditolak; nonce dari tanda tangan palsu tidak ikut terbakar", async () => {
  const short = { ...makeAuth(), nonce: randomBytes(16).toString("base64") };
  assert.equal(err(await evaluateGenome(body(short), okRpc(), CONTRACT, deps())), "invalid_nonce");

  const d = deps();
  const nonce = randomBytes(32);
  const forged = { ...makeAuth({ nonce }), signature: Buffer.alloc(64, 2).toString("base64") };
  assert.equal(err(await evaluateGenome(body(forged), okRpc(), CONTRACT, d)), "invalid_signature");
  // pemilik asli masih bisa memakai nonce yang sama (penyerang tak bisa membakarnya)
  assert.equal((await evaluateGenome(body(makeAuth({ nonce })), okRpc(), CONTRACT, d)).status, 200);
});

test("bukan pemilik strain -> 403 not_strain_owner (tanda tangan sah, kunci sah)", async () => {
  const tee: TeeMock = { urls: [], auths: [] };
  const rpc = mockRpc({ keyPermission: "FullAccess", strainOwner: "bob.testnet", calls: [] });
  const r = await evaluateGenome(body(makeAuth()), rpc, CONTRACT, deps({}, tee));
  assert.deepEqual([r.status, err(r)], [403, "not_strain_owner"]);
  assert.equal(tee.urls.length, 0, "TEE tidak boleh dipanggil");
});

test("kunci publik tidak milik akun -> 403 (dua gaya error RPC); FunctionCall key ditolak", async () => {
  for (const style of ["result", "jsonrpc"] as const) {
    const r = await evaluateGenome(
      body(makeAuth()),
      mockRpc({ keyPermission: undefined, keyMissingStyle: style, calls: [] }),
      CONTRACT,
      deps(),
    );
    assert.deepEqual([r.status, err(r)], [403, "public_key_not_owned"], style);
  }
  const fc = { FunctionCall: { allowance: "1", receiver_id: CONTRACT, method_names: [] } };
  const r = await evaluateGenome(body(makeAuth()), mockRpc({ keyPermission: fc, calls: [] }), CONTRACT, deps());
  assert.deepEqual([r.status, err(r)], [403, "public_key_not_full_access"]);
});

test("strain tidak ada -> 404", async () => {
  const r = await evaluateGenome(body(makeAuth()), mockRpc({ keyPermission: "FullAccess", strainOwner: null, calls: [] }), CONTRACT, deps());
  assert.deepEqual([r.status, err(r)], [404, "strain_not_found"]);
});

test("rate limit 3/jam per strain -> 429 + Retry-After; pulih setelah 1 jam", async () => {
  let t = NOW;
  const d = deps({ now: () => t });
  const go = (ts = t) => evaluateGenome(body(makeAuth({ ts })), okRpc(), CONTRACT, d);
  for (let i = 0; i < 3; i++) {
    assert.equal((await go()).status, 200, `request ${i + 1}`);
    t += 1000;
  }
  const r = await go();
  assert.equal(r.status, 429);
  const b = r.body as { error: string; scope: string; retryAfterSec: number };
  assert.deepEqual([b.error, b.scope], ["rate_limited", "strain"]);
  assert.equal(r.headers?.["Retry-After"], String(b.retryAfterSec));
  assert.ok(b.retryAfterSec > 3500 && b.retryAfterSec <= 3600);
  t = NOW + 3_600_000 + 1;
  assert.equal((await go()).status, 200);
});

test("rate limit: strain lain tidak terpengaruh; total 50/hari -> 429 scope global; pulih setelah 24 jam", () => {
  const l = new RateLimiter();
  for (let i = 0; i < 3; i++) assert.equal(l.take(1, NOW + i).ok, true);
  assert.equal(l.take(1, NOW + 10).ok, false);
  assert.equal(l.take(2, NOW + 10).ok, true);
  // isi sampai batas harian: strain 3..N, 3/strain, tersebar >1 jam agar batas per-strain tak menghalangi
  let n = 4; // sudah terpakai 3 + 1
  let strain = 3;
  let ts = NOW + 3_600_001;
  while (n < RATE_TOTAL_PER_DAY) {
    assert.equal(l.take(strain, ts).ok, true);
    n++;
    strain++;
  }
  const blocked = l.take(9999, ts);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.scope, "global");
  assert.equal(l.take(9999, NOW + 86_400_000 + 3_600_002).ok, true);
});

test("TEE gagal -> 502 tanpa membocorkan kunci; mutasi di luar guardrail I-03 -> 502", async () => {
  const leak: TeeMock = {
    urls: [],
    auths: [],
    failChat: () => {
      throw new Error(`connect refused with header Bearer ${API_KEY}`);
    },
  };
  let r = await evaluateGenome(body(makeAuth()), okRpc(), CONTRACT, deps({}, leak));
  assert.deepEqual([r.status, err(r)], [502, "tee_upstream_failed"]);
  assert.ok(!JSON.stringify(r.body).includes(API_KEY));

  const bad: TeeMock = { urls: [], auths: [], content: JSON.stringify({ efficiency_shift_bps: 9999, vitality_bonus: 1 }) };
  r = await evaluateGenome(body(makeAuth()), okRpc(), CONTRACT, deps({}, bad));
  assert.deepEqual([r.status, err(r)], [502, "tee_guardrail_rejected"]);
});

test("RPC hulu gagal -> melempar RpcError (ditangkap route() jadi 503), bukan 403 palsu", async () => {
  const rpc = new NearRpcClient("http://rpc.test", (async () => new Response("x", { status: 500 })) as unknown as typeof fetch, 0);
  await assert.rejects(() => evaluateGenome(body(makeAuth()), rpc, CONTRACT, deps()), /HTTP 500/);
});

// ---- lewat route() dengan stream request nyata ----
function postReq(path: string, payload: string | Buffer, method = "POST"): IncomingMessage {
  const r = Readable.from([Buffer.from(payload)]) as unknown as IncomingMessage;
  (r as unknown as { url: string; method: string }).url = path;
  (r as unknown as { url: string; method: string }).method = method;
  return r;
}

test("route: 405 bila bukan POST; 503 tanpa kunci; 400 JSON rusak; 413 body besar; 200 end-to-end", async () => {
  const base = { rpc: okRpc(), contractId: CONTRACT, store: newStore() };
  let res = await route(postReq("/api/tee/evaluate-genome", "", "GET"), { ...base, evaluate: deps() });
  assert.equal(res.status, 405);
  assert.equal(res.headers?.["Allow"], "POST");

  res = await route(postReq("/api/tee/evaluate-genome", "{}"), base); // tanpa deps.evaluate
  assert.deepEqual([res.status, res.body], [503, { error: "tee_not_configured" }]);
  res = await route(postReq("/api/tee/evaluate-genome", "{}"), { ...base, evaluate: deps({ apiKey: undefined }) });
  assert.deepEqual([res.status, res.body], [503, { error: "tee_not_configured" }]);

  res = await route(postReq("/api/tee/evaluate-genome", "{bukan json"), { ...base, evaluate: deps() });
  assert.deepEqual([res.status, res.body], [400, { error: "invalid_json" }]);

  res = await route(postReq("/api/tee/evaluate-genome", Buffer.alloc(20_000, 0x20)), { ...base, evaluate: deps() });
  assert.equal(res.status, 413);

  res = await route(postReq("/api/tee/evaluate-genome", JSON.stringify(body(makeAuth()))), { ...base, evaluate: deps() });
  assert.equal(res.status, 200);
  assert.ok(!JSON.stringify(res.body).includes(API_KEY));
});

test("route: RpcError saat otorisasi dipetakan 503 rpc_unavailable", async () => {
  const rpc = new NearRpcClient("http://rpc.test", (async () => new Response("x", { status: 500 })) as unknown as typeof fetch, 0);
  const res = await route(postReq("/api/tee/evaluate-genome", JSON.stringify(body(makeAuth()))), {
    rpc,
    contractId: CONTRACT,
    store: newStore(),
    evaluate: deps(),
  });
  assert.equal(res.status, 503);
  assert.equal(err(res), "rpc_unavailable");
});
