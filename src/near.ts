/**
 * Minimal NEAR JSON-RPC client (0 runtime dependencies).
 * `fetchFn` can be injected for unit tests (INT-108).
 */

export interface JsonRpcResponse<T> {
  result?: T;
  error?: { code: number; message: string; data?: unknown };
  id?: string | number | null;
}

export interface ViewAccountResult {
  amount: string;
  code_hash: string;
  locked: string;
  storage_usage: number;
}

export interface CallFunctionResult {
  result: number[]; // base64-decoded bytes of the serialized return value
  logs: string[];
  block_height: number;
  block_hash: string;
}

export interface ChunkResult {
  author: string;
  header: { height: number; chunk_hash: string };
  receipts: Array<{
    receipt_id: string;
    outcome: { logs: string[]; success_receipt_id?: string };
  }>;
}

export class RpcError extends Error {
  constructor(
    public readonly rpcError: NonNullable<JsonRpcResponse<unknown>["error"]>,
  ) {
    super(`JSON-RPC error ${rpcError.code}: ${rpcError.message}`);
    this.name = "RpcError";
  }
}

const RETRY_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/** Contract view method panicked: RPC returns `result.error` (not top-level `error`) without `result.result`. */
export class ViewPanicError extends Error {
  constructor(
    public readonly method: string,
    public readonly detail: string,
  ) {
    super(`view ${method} panicked: ${detail}`);
    this.name = "ViewPanicError";
  }
}

/**
 * u128 values in contract views are emitted as unquoted numeric literals (e.g. `"atp_balance":575782630`);
 * `JSON.parse` truncates them to float64. Wrap named u128 fields in quotes BEFORE parsing
 * so full precision is preserved ("u128 = exact string" principle). Only transforms `"key": <digits>`.
 */
export function quoteU128Fields(text: string, keys: readonly string[]): string {
  let out = text;
  for (const key of keys) {
    out = out.replace(new RegExp(`("${key}"\\s*:\\s*)(\\d+)(?![\\d.eE])`, "g"), '$1"$2"');
  }
  return out;
}

export class NearRpcClient {
  constructor(
    private readonly rpcUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
    /** Base retry delay (ms) for HTTP 429/502/503/504 from public RPC; 0 = no delay (tests). */
    private readonly retryDelayMs: number = 400,
  ) {}

  async fetchJsonRpc<T>(method: string, params: unknown): Promise<T> {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: "snacc-backend", method, params });
    let res!: Response;
    for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
      res = await this.fetchFn(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      if (!RETRYABLE_STATUS.has(res.status) || attempt === RETRY_ATTEMPTS) break;
      await new Promise((ok) => setTimeout(ok, this.retryDelayMs * 2 ** attempt));
    }
    if (!res.ok) {
      throw new RpcError({
        code: -32000,
        message: `HTTP ${res.status} from RPC`,
      });
    }
    const body = (await res.json()) as JsonRpcResponse<T>;
    if (body.error) throw new RpcError(body.error);
    if (body.result === undefined) {
      throw new RpcError({ code: -32603, message: "response missing result" });
    }
    return body.result;
  }

  viewAccount(accountId: string): Promise<ViewAccountResult> {
    return this.fetchJsonRpc<ViewAccountResult>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
  }

  /** Call a contract view method; NEAR-serialized return value is decoded to UTF-8 text. */
  async viewFunction(
    contractId: string,
    methodName: string,
    argsBase64: string,
  ): Promise<{ text: string; logs: string[]; block_height: number }> {
    const r = await this.fetchJsonRpc<CallFunctionResult & { error?: string }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: methodName,
      args_base64: argsBase64,
    });
    if (!Array.isArray(r.result)) {
      throw new ViewPanicError(methodName, String(r.error ?? "view response missing result"));
    }
    const text = Buffer.from(r.result).toString("utf8");
    return { text, logs: r.logs, block_height: r.block_height };
  }

  /**
   * `view_access_key`: key permission on the account, or `null` if the key/account does not exist.
   * NEAR nodes report "not found" either as a JSON-RPC error or as `result.error` without `permission`.
   */
  async viewAccessKey(accountId: string, publicKey: string): Promise<{ permission: unknown } | null> {
    const missing = (s: string): boolean =>
      /UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist while viewing/i.test(s);
    try {
      const r = await this.fetchJsonRpc<{ permission?: unknown; error?: string }>("query", {
        request_type: "view_access_key",
        finality: "final",
        account_id: accountId,
        public_key: publicKey,
      });
      if (r.permission !== undefined) return { permission: r.permission };
      if (typeof r.error === "string" && missing(r.error)) return null;
      throw new RpcError({ code: -32603, message: "view_access_key missing permission" });
    } catch (err) {
      if (err instanceof RpcError && missing(`${err.rpcError.message} ${JSON.stringify(err.rpcError.data ?? "")}`)) {
        return null;
      }
      throw err;
    }
  }

  chunk(chunkHash: string): Promise<ChunkResult> {
    return this.fetchJsonRpc<ChunkResult>("chunk", { chunk_id: chunkHash });
  }
}

/** True when the RPC error indicates the account/contract is not deployed (never fabricate data). */
export function isContractNotDeployed(err: unknown): boolean {
  if (!(err instanceof RpcError)) return false;
  const s = `${err.rpcError.message} ${JSON.stringify(err.rpcError.data ?? "")}`;
  return (
    s.includes("does not exist while viewing") ||
    s.includes("ContractCodeNotFound") ||
    s.includes("has no contract")
  );
}
