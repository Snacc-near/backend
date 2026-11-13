/**
 * Minimal NEAR testnet JSON-RPC client + pure response parsers for the Snacc Edge Functions.
 * Pure TypeScript (fetch / AbortSignal only) so it runs in Deno and in Node tests.
 * Endpoints are tried in order; only transport failures and RPC INTERNAL_ERRORs fall through to the next
 * endpoint. Handler errors (unknown key, unknown tx, ...) are definitive and thrown as `NearRpcError`.
 */

import { base64Decode, base64Encode, utf8 } from "./nep413.ts";

export const TESTNET_RPC_URLS: readonly string[] = ["https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com"];
/** Used only for `EXPERIMENTAL_tx_status` when regular nodes no longer hold the tx (garbage-collected after ~5 epochs). */
export const TESTNET_ARCHIVAL_RPC_URL = "https://archival-rpc.testnet.fastnear.com";
export const DEFAULT_CONTRACT_ID = "snacc-v001.testnet";

/** `SNACC_CONTRACT_ID` overrides the default contract. */
export function resolveContractId(getEnv: (k: string) => string | undefined): string {
  const v = getEnv("SNACC_CONTRACT_ID")?.trim();
  return v ? v : DEFAULT_CONTRACT_ID;
}

export class NearRpcError extends Error {
  constructor(
    /** "transport" = network/HTTP/JSON problem; "rpc" = the node answered with a JSON-RPC error. */
    readonly kind: "transport" | "rpc",
    message: string,
    /** e.g. HANDLER_ERROR, INTERNAL_ERROR, REQUEST_VALIDATION_ERROR. */
    readonly rpcName?: string,
    /** e.g. UNKNOWN_ACCESS_KEY, UNKNOWN_ACCOUNT, UNKNOWN_TRANSACTION, TIMEOUT_ERROR, INVALID_TRANSACTION. */
    readonly causeName?: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "NearRpcError";
  }
}

interface RawRpcError {
  name?: string;
  cause?: { name?: string; info?: unknown };
  code?: number;
  message?: string;
  data?: unknown;
}

const LEGACY_CAUSES: Array<[RegExp, string]> = [
  [/UNKNOWN_ACCESS_KEY|access key .* does not exist/i, "UNKNOWN_ACCESS_KEY"],
  [/UNKNOWN_ACCOUNT|account .* does not exist/i, "UNKNOWN_ACCOUNT"],
  [/UNKNOWN_TRANSACTION|Transaction .* doesn't exist/i, "UNKNOWN_TRANSACTION"],
  [/TIMEOUT/i, "TIMEOUT_ERROR"],
];

/** Normalize a JSON-RPC error (structured `cause` or legacy string `data`) into a `NearRpcError`. */
export function toNearRpcError(e: RawRpcError): NearRpcError {
  let cause = e.cause?.name;
  const text = `${typeof e.data === "string" ? e.data : JSON.stringify(e.data ?? "")} ${e.message ?? ""}`;
  if (!cause) cause = LEGACY_CAUSES.find(([re]) => re.test(text))?.[1];
  return new NearRpcError("rpc", `${e.name ?? "RPC_ERROR"}${cause ? `/${cause}` : ""}: ${text.slice(0, 200)}`, e.name, cause, e.data ?? e.cause?.info);
}

function isTransient(err: NearRpcError): boolean {
  return err.kind === "transport" || err.rpcName === "INTERNAL_ERROR";
}

export interface NearRpcOptions {
  urls?: readonly string[];
  /** `null` disables the archival fallback. */
  archivalUrl?: string | null;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------------------------
// Access keys
// ---------------------------------------------------------------------------------------------

export type AccessKeyPermission =
  | { kind: "FullAccess" }
  | { kind: "FunctionCall"; receiverId: string; methodNames: string[]; allowance: string | null }
  | { kind: "Unknown" };

/** Parse the `permission` field of a `view_access_key` result. */
export function parseAccessKeyPermission(p: unknown): AccessKeyPermission {
  if (p === "FullAccess") return { kind: "FullAccess" };
  if (p && typeof p === "object" && "FunctionCall" in p) {
    const fc = (p as { FunctionCall?: Record<string, unknown> }).FunctionCall ?? {};
    const names = Array.isArray(fc["method_names"]) ? fc["method_names"].filter((m): m is string => typeof m === "string") : [];
    const allowance = typeof fc["allowance"] === "string" ? fc["allowance"] : null;
    return { kind: "FunctionCall", receiverId: String(fc["receiver_id"] ?? ""), methodNames: names, allowance };
  }
  return { kind: "Unknown" };
}

export interface AccessKeyView {
  permission: AccessKeyPermission;
  nonce: bigint;
  blockHash: string;
}

// ---------------------------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------------------------

export interface FunctionCallSummary {
  methodName: string;
  /** JSON-decoded args, or `null` when the args are not JSON. */
  args: unknown;
  deposit: string;
}

export interface TxSummary {
  hash: string;
  signerId: string;
  receiverId: string;
  /** "success" (SuccessValue), "failure" (Failure) or "pending" (anything else, e.g. NotStarted/Started). */
  outcome: "success" | "failure" | "pending";
  /** Base64 SuccessValue of the final status ("" for unit), `null` when not a success. */
  successValue: string | null;
  /** Block that included the transaction (`transaction_outcome.block_hash`). */
  blockHash: string | null;
  /** First FunctionCall action, `null` when the tx has none. */
  firstCall: FunctionCallSummary | null;
}

function decodeJsonB64(b64: unknown): unknown {
  if (typeof b64 !== "string" || b64 === "") return null;
  const bytes = base64Decode(b64);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** Summarize an `EXPERIMENTAL_tx_status` / `tx` result; `null` when the shape is not recognisable. */
export function summarizeTxStatus(result: unknown): TxSummary | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const tx = r["transaction"] as Record<string, unknown> | undefined;
  if (!tx || typeof tx["signer_id"] !== "string" || typeof tx["receiver_id"] !== "string") return null;

  const status = r["status"];
  let outcome: TxSummary["outcome"] = "pending";
  let successValue: string | null = null;
  if (status && typeof status === "object") {
    if ("SuccessValue" in status) {
      outcome = "success";
      const v = (status as { SuccessValue?: unknown }).SuccessValue;
      successValue = typeof v === "string" ? v : "";
    } else if ("Failure" in status) {
      outcome = "failure";
    }
  }

  let firstCall: FunctionCallSummary | null = null;
  const actions = Array.isArray(tx["actions"]) ? tx["actions"] : [];
  for (const a of actions) {
    if (a && typeof a === "object" && "FunctionCall" in a) {
      const fc = (a as { FunctionCall?: Record<string, unknown> }).FunctionCall ?? {};
      if (typeof fc["method_name"] !== "string") continue;
      firstCall = { methodName: fc["method_name"], args: decodeJsonB64(fc["args"]), deposit: String(fc["deposit"] ?? "0") };
      break;
    }
  }

  const txo = r["transaction_outcome"] as Record<string, unknown> | undefined;
  return {
    hash: String(tx["hash"] ?? ""),
    signerId: tx["signer_id"],
    receiverId: tx["receiver_id"],
    outcome,
    successValue,
    blockHash: typeof txo?.["block_hash"] === "string" ? txo["block_hash"] : null,
    firstCall,
  };
}

const U63_MAX = 9223372036854775807n;

function asStrainId(v: unknown): string | null {
  const s = typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === "string" ? v : null;
  if (s === null || !/^\d{1,19}$/.test(s) || BigInt(s) > U63_MAX) return null;
  return String(BigInt(s));
}

/** Strain id from call args: `strain_id`, else `target_id` (adopt), else `token_id` (NEP-171). */
export function extractStrainId(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  for (const k of ["strain_id", "target_id", "token_id"]) {
    if (k in a) {
      const id = asStrainId(a[k]);
      if (id !== null) return id;
    }
  }
  return null;
}

/** Strain id from a SuccessValue (`incubate_strain` returns the new StrainVesselView). */
export function strainIdFromReturn(successValue: string | null): string | null {
  const v = decodeJsonB64(successValue);
  if (v && typeof v === "object" && !Array.isArray(v)) return asStrainId((v as Record<string, unknown>)["strain_id"]);
  return null;
}

export type TxCheckError = "tx_signer_mismatch" | "tx_wrong_receiver" | "tx_failed" | "tx_pending" | "tx_not_function_call";

/** Rules for recording an activity: signed by the caller's account, sent to the contract, successful, a FunctionCall. */
export function checkTxForAccount(s: TxSummary, expected: { accountId: string; contractId: string }): TxCheckError | null {
  if (s.signerId !== expected.accountId) return "tx_signer_mismatch";
  if (s.receiverId !== expected.contractId) return "tx_wrong_receiver";
  if (s.outcome === "failure") return "tx_failed";
  if (s.outcome !== "success") return "tx_pending";
  if (!s.firstCall) return "tx_not_function_call";
  return null;
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

export class NearRpc {
  readonly urls: readonly string[];
  readonly archivalUrl: string | null;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: NearRpcOptions = {}) {
    this.urls = opts.urls && opts.urls.length > 0 ? opts.urls : TESTNET_RPC_URLS;
    this.archivalUrl = opts.archivalUrl === undefined ? TESTNET_ARCHIVAL_RPC_URL : opts.archivalUrl;
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 12_000;
  }

  async request<T>(method: string, params: unknown, urls: readonly string[] = this.urls): Promise<T> {
    let last: NearRpcError | undefined;
    for (const url of urls) {
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "snacc", method, params }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        last = new NearRpcError("transport", `${url}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      let body: { result?: unknown; error?: RawRpcError };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        last = new NearRpcError("transport", `${url}: HTTP ${res.status} non-JSON body`);
        continue;
      }
      if (body && body.error) {
        const err = toNearRpcError(body.error);
        if (isTransient(err)) {
          last = err;
          continue;
        }
        throw err;
      }
      if (!body || !("result" in body)) {
        last = new NearRpcError("transport", `${url}: HTTP ${res.status} without result`);
        continue;
      }
      return body.result as T;
    }
    throw last ?? new NearRpcError("transport", "no RPC endpoint configured");
  }

  /** `view_access_key`; `null` when the key or the account does not exist. */
  async viewAccessKey(accountId: string, publicKey: string): Promise<AccessKeyView | null> {
    try {
      const r = await this.request<{ permission?: unknown; nonce?: number | string; block_hash?: string; error?: string }>("query", {
        request_type: "view_access_key",
        finality: "final",
        account_id: accountId,
        public_key: publicKey,
      });
      if (r.permission === undefined) {
        if (typeof r.error === "string" && /does not exist|UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT/i.test(r.error)) return null;
        throw new NearRpcError("rpc", "view_access_key: missing permission");
      }
      return {
        permission: parseAccessKeyPermission(r.permission),
        nonce: BigInt(r.nonce ?? 0),
        blockHash: String(r.block_hash ?? ""),
      };
    } catch (e) {
      if (e instanceof NearRpcError && (e.causeName === "UNKNOWN_ACCESS_KEY" || e.causeName === "UNKNOWN_ACCOUNT")) return null;
      throw e;
    }
  }

  /** `view_account`; `null` when the account does not exist (e.g. an unfunded implicit account). */
  async viewAccount(accountId: string): Promise<{ amount: string; locked: string } | null> {
    try {
      const r = await this.request<{ amount?: string; locked?: string; error?: string }>("query", {
        request_type: "view_account",
        finality: "final",
        account_id: accountId,
      });
      if (typeof r.amount !== "string") {
        if (typeof r.error === "string" && /does not exist|UNKNOWN_ACCOUNT/i.test(r.error)) return null;
        throw new NearRpcError("rpc", "view_account: missing amount");
      }
      return { amount: r.amount, locked: String(r.locked ?? "0") };
    } catch (e) {
      if (e instanceof NearRpcError && e.causeName === "UNKNOWN_ACCOUNT") return null;
      throw e;
    }
  }

  /** `call_function` view, JSON-decoded. Throws `NearRpcError` on contract panics. */
  async callView<T>(contractId: string, methodName: string, args: unknown): Promise<T> {
    const r = await this.request<{ result?: number[]; error?: string }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: methodName,
      args_base64: base64Encode(utf8(JSON.stringify(args ?? {}))),
    });
    if (!Array.isArray(r.result)) throw new NearRpcError("rpc", `${methodName}: ${String(r.error ?? "no result").slice(0, 200)}`, "HANDLER_ERROR", "CONTRACT_EXECUTION_ERROR");
    return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result))) as T;
  }

  /**
   * `EXPERIMENTAL_tx_status` (sender = `senderId`). Falls back to the archival node when regular nodes
   * answer UNKNOWN_TRANSACTION (tx older than the GC window).
   */
  async txStatus(txHash: string, senderId: string, waitUntil = "FINAL"): Promise<unknown> {
    const params = { tx_hash: txHash, sender_account_id: senderId, wait_until: waitUntil };
    try {
      return await this.request<unknown>("EXPERIMENTAL_tx_status", params);
    } catch (e) {
      if (this.archivalUrl && e instanceof NearRpcError && e.causeName === "UNKNOWN_TRANSACTION") {
        return await this.request<unknown>("EXPERIMENTAL_tx_status", params, [this.archivalUrl]);
      }
      throw e;
    }
  }

  /** Block timestamp (ms since epoch) of `blockHash`; archival fallback for old blocks. */
  async blockTimestampMs(blockHash: string): Promise<number> {
    const read = (b: { header?: { timestamp_nanosec?: string; timestamp?: number } }) => {
      const ns = b.header?.timestamp_nanosec;
      if (typeof ns === "string" && /^\d+$/.test(ns)) return Number(BigInt(ns) / 1_000_000n);
      if (typeof b.header?.timestamp === "number") return Math.floor(b.header.timestamp / 1_000_000);
      throw new NearRpcError("rpc", "block: missing header timestamp");
    };
    try {
      return read(await this.request("block", { block_id: blockHash }));
    } catch (e) {
      if (this.archivalUrl && e instanceof NearRpcError && e.kind === "rpc") {
        return read(await this.request("block", { block_id: blockHash }, [this.archivalUrl]));
      }
      throw e;
    }
  }

  /** `send_tx` with a base64 SignedTransaction. Not retried on other endpoints after a definitive answer. */
  async sendTx(signedTxBase64: string, waitUntil = "EXECUTED_OPTIMISTIC"): Promise<unknown> {
    return this.request<unknown>("send_tx", { signed_tx_base64: signedTxBase64, wait_until: waitUntil });
  }
}
