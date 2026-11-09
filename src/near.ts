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

/** Default per-endpoint cooldown after an HTTP 429 (exponential backoff, capped). */
const DEFAULT_COOLDOWN_BASE_MS = 60_000;
const DEFAULT_COOLDOWN_MAX_MS = 600_000;
/** Short TTL for contract view results (`call_function`); the poller (`tx`/`block`) is never cached. */
const DEFAULT_VIEW_CACHE_TTL_MS = 10_000;
/** While every endpoint is down, a still-present cached view may be served stale up to this age. */
const DEFAULT_VIEW_STALE_TTL_MS = 120_000;

export interface RpcPoolOptions {
  /** Base cooldown for an endpoint that answered 429 (exponential: base * 2^(fails-1)). */
  cooldownBaseMs?: number;
  /** Upper bound for the exponential cooldown. */
  cooldownMaxMs?: number;
  /** Fresh-serve window for cached contract views. */
  viewCacheTtlMs?: number;
  /** Maximum age (since fetch) of a cached view served while all endpoints fail. */
  viewStaleTtlMs?: number;
}

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

interface CacheEntry {
  text: string;
  logs: string[];
  block_height: number;
  fetchedAt: number;
}

export class NearRpcClient {
  private readonly urls: string[];
  /** Per-endpoint 429 cooldown state (exponential backoff). */
  private readonly cooldown = new Map<string, { until: number; fails: number }>();
  private rrIndex = 0;
  private readonly cooldownBaseMs: number;
  private readonly cooldownMaxMs: number;
  private readonly viewCacheTtlMs: number;
  private readonly viewStaleTtlMs: number;
  private readonly viewCache = new Map<string, CacheEntry>();

  constructor(
    rpcUrl: string | string[],
    private readonly fetchFn: typeof fetch = fetch,
    /** Base retry delay (ms) for HTTP 429/502/503/504 from public RPC; 0 = no delay (tests). */
    private readonly retryDelayMs: number = 400,
    /** Per-request timeout (ms); a hanging RPC must not stall the poller. 0 = no timeout (tests). */
    private readonly timeoutMs: number = 10000,
    options: RpcPoolOptions = {},
  ) {
    const list = (Array.isArray(rpcUrl) ? rpcUrl : rpcUrl.split(","))
      .map((u) => u.trim())
      .filter((u) => u.length > 0);
    if (list.length === 0) throw new Error("NearRpcClient: no RPC URL configured");
    this.urls = list;
    this.cooldownBaseMs = options.cooldownBaseMs ?? DEFAULT_COOLDOWN_BASE_MS;
    this.cooldownMaxMs = options.cooldownMaxMs ?? DEFAULT_COOLDOWN_MAX_MS;
    this.viewCacheTtlMs = options.viewCacheTtlMs ?? DEFAULT_VIEW_CACHE_TTL_MS;
    this.viewStaleTtlMs = options.viewStaleTtlMs ?? DEFAULT_VIEW_STALE_TTL_MS;
  }

  /** Endpoints configured for this client (for logging). */
  get endpoints(): readonly string[] {
    return this.urls;
  }

  /**
   * Pick the next endpoint: round-robin over the ones not in 429 cooldown.
   * When EVERY endpoint is cooling down, reuse the soonest-expiring one anyway —
   * the per-request attempt cap (RETRY_ATTEMPTS) keeps this from becoming a retry storm.
   */
  private pickUrl(): string {
    const now = Date.now();
    const available = this.urls.filter((u) => (this.cooldown.get(u)?.until ?? 0) <= now);
    if (available.length > 0) {
      const url = available[this.rrIndex % available.length] as string;
      this.rrIndex = (this.rrIndex + 1) % available.length;
      return url;
    }
    // All endpoints are cooling down: reuse the soonest-expiring one (bounded by the attempt cap).
    return this.urls.reduce(
      (best, u) =>
        (this.cooldown.get(u)?.until ?? 0) < (this.cooldown.get(best)?.until ?? 0) ? u : best,
      this.urls[0] as string,
    );
  }

  /** Put an endpoint in cooldown after an HTTP 429 (exponential, capped). */
  private mark429(url: string): void {
    const fails = (this.cooldown.get(url)?.fails ?? 0) + 1;
    const until = Date.now() + Math.min(this.cooldownBaseMs * 2 ** (fails - 1), this.cooldownMaxMs);
    this.cooldown.set(url, { until, fails });
  }

  private markSuccess(url: string): void {
    this.cooldown.delete(url);
  }

  async fetchJsonRpc<T>(method: string, params: unknown): Promise<T> {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: "snacc-backend", method, params });
    let lastErr: unknown;
    // Bounded per-request attempts (1 initial + RETRY_ATTEMPTS): rotation across endpoints
    // must never turn into an unbounded retry storm against rate-limited public RPC.
    for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
      const url = this.pickUrl();
      // A fresh timeout signal per attempt: a hanging RPC (no response) is aborted instead of
      // stalling the poller loop. timeoutMs = 0 disables it (unit tests).
      const signal = this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined;
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          signal,
        });
      } catch (err) {
        // Network error / timeout -> try the next endpoint.
        lastErr = err;
        if (this.retryDelayMs > 0 && attempt < RETRY_ATTEMPTS) {
          await new Promise((ok) => setTimeout(ok, this.retryDelayMs * 2 ** attempt));
        }
        continue;
      }
      if (res.status === 429) {
        // Rate-limited: this endpoint goes into (exponential) cooldown, rotate to the next.
        this.mark429(url);
        lastErr = new RpcError({ code: -32000, message: `HTTP 429 from ${url}` });
        if (this.retryDelayMs > 0 && attempt < RETRY_ATTEMPTS) {
          await new Promise((ok) => setTimeout(ok, this.retryDelayMs * 2 ** attempt));
        }
        continue;
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_ATTEMPTS) {
        // 5xx: rotate to the next endpoint (no cooldown; rotation itself sheds the load).
        lastErr = new RpcError({ code: -32000, message: `HTTP ${res.status} from ${url}` });
        if (this.retryDelayMs > 0) {
          await new Promise((ok) => setTimeout(ok, this.retryDelayMs * 2 ** attempt));
        }
        continue;
      }
      if (!res.ok) {
        throw new RpcError({ code: -32000, message: `HTTP ${res.status} from ${url}` });
      }
      this.markSuccess(url);
      const body = (await res.json()) as JsonRpcResponse<T>;
      if (body.error) throw new RpcError(body.error);
      if (body.result === undefined) {
        throw new RpcError({ code: -32603, message: "response missing result" });
      }
      return body.result;
    }
    if (lastErr instanceof RpcError) throw lastErr;
    throw new RpcError({
      code: -32000,
      message: `all RPC endpoints failed (${this.urls.length} configured): ${String(lastErr)}`,
    });
  }

  viewAccount(accountId: string): Promise<ViewAccountResult> {
    return this.fetchJsonRpc<ViewAccountResult>("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
  }

  /**
   * Call a contract view method; NEAR-serialized return value is decoded to UTF-8 text.
   * Results are cached briefly per (contract, method, args). While every endpoint is failing,
   * a still-present cached entry (age <= viewStaleTtlMs) is served stale and `staleSeconds`
   * reports its age — never fabricated data, always labelled.
   */
  async viewFunction(
    contractId: string,
    methodName: string,
    argsBase64: string,
  ): Promise<{ text: string; logs: string[]; block_height: number; staleSeconds?: number }> {
    const key = `${contractId}:${methodName}:${argsBase64}`;
    const now = Date.now();
    const cached = this.viewCache.get(key);
    if (cached && now - cached.fetchedAt < this.viewCacheTtlMs) {
      return { text: cached.text, logs: cached.logs, block_height: cached.block_height };
    }
    try {
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
      const out = { text, logs: r.logs, block_height: r.block_height };
      this.viewCache.set(key, { ...out, fetchedAt: now });
      return out;
    } catch (err) {
      // All endpoints failed (or a non-panic RPC error): serve the stale cache only when it
      // exists and is within the stale window; the response is labelled with its age.
      if (
        cached &&
        now - cached.fetchedAt <= this.viewStaleTtlMs &&
        !(err instanceof ViewPanicError)
      ) {
        return {
          text: cached.text,
          logs: cached.logs,
          block_height: cached.block_height,
          staleSeconds: Math.max(1, Math.floor((now - cached.fetchedAt) / 1000)),
        };
      }
      throw err;
    }
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
