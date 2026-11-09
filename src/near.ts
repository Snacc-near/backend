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
const EMPTY_SET: ReadonlySet<string> = new Set();

/** Default per-endpoint cooldown after an HTTP 429 (exponential backoff, capped). */
const DEFAULT_COOLDOWN_BASE_MS = 60_000;
const DEFAULT_COOLDOWN_MAX_MS = 600_000;
/** Hard cap for a server-advertised `Retry-After` (1 h): a bogus huge value cannot park an endpoint forever. */
const RETRY_AFTER_CAP_MS = 3_600_000;
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

export interface RpcEndpointStatus {
  /** Host only (no path, no credentials) — safe to expose publicly. */
  host: string;
  /** ISO timestamp when the 429 cooldown ends; `null` when the endpoint is usable. */
  cooldownUntil: string | null;
  /** Seconds until the cooldown ends; 0 when usable. */
  cooldownSeconds: number;
  /** Consecutive 429s recorded (drives the exponential cooldown growth). */
  failures: number;
}

export interface RpcStatus {
  /** Host of the endpoint that last answered successfully; `null` before the first success. */
  currentHost: string | null;
  endpoints: RpcEndpointStatus[];
  cache: {
    hits: number;
    misses: number;
    staleServed: number;
    size: number;
  };
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

type ViewResult = { text: string; logs: string[]; block_height: number; staleSeconds?: number };

export class NearRpcClient {
  private readonly urls: string[];
  /** Per-endpoint 429 cooldown state (exponential backoff). */
  private readonly cooldown = new Map<string, { until: number; fails: number }>();
  private rrIndex = 0;
  /** Endpoint that last answered successfully; preferred while it is not cooling down. */
  private lastHealthy: string | null = null;
  private readonly cooldownBaseMs: number;
  private readonly cooldownMaxMs: number;
  private readonly viewCacheTtlMs: number;
  private readonly viewStaleTtlMs: number;
  private readonly viewCache = new Map<string, CacheEntry>();
  /** In-flight `viewFunction` promises (de-dup): concurrent identical calls share one RPC request. */
  private readonly viewInflight = new Map<string, Promise<ViewResult>>();
  /** Fresh-serve hits, fetch misses, and stale serves, for /api/health. */
  private cacheHits = 0;
  private cacheMisses = 0;
  private cacheStale = 0;

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
   * Pick the next endpoint: the last healthy one while it is not cooling down
   * (steady-state traffic stays on one endpoint, sparing the others' rate budget);
   * otherwise round-robin over the endpoints not in 429 cooldown. When EVERY endpoint
   * is cooling down, reuse the soonest-expiring one anyway — the per-request attempt
   * cap (RETRY_ATTEMPTS) keeps this from becoming a retry storm.
   */
  private pickUrl(exclude: ReadonlySet<string> = EMPTY_SET): string {
    const now = Date.now();
    const usable = (u: string): boolean => (this.cooldown.get(u)?.until ?? 0) <= now;
    if (
      this.lastHealthy !== null &&
      usable(this.lastHealthy) &&
      !exclude.has(this.lastHealthy)
    ) {
      return this.lastHealthy;
    }
    const available = this.urls.filter((u) => usable(u) && !exclude.has(u));
    if (available.length > 0) {
      const url = available[this.rrIndex % available.length] as string;
      this.rrIndex = (this.rrIndex + 1) % available.length;
      return url;
    }
    // Everything is excluded or cooling down: reuse the least-bad one (excluded-first is
    // avoided when a merely-cooling endpoint exists) — the attempt cap bounds this anyway.
    const untried = this.urls.filter((u) => !exclude.has(u));
    const pool = untried.length > 0 ? untried : this.urls;
    return pool.reduce(
      (best, u) =>
        (this.cooldown.get(u)?.until ?? 0) < (this.cooldown.get(best)?.until ?? 0) ? u : best,
      pool[0] as string,
    );
  }

  /** Parse a `Retry-After` header (delta-seconds or HTTP date) to milliseconds, or `undefined`. */
  private retryAfterMs(res: Response): number | undefined {
    const raw = res.headers.get("retry-after");
    if (raw === null) return undefined;
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
    const when = Date.parse(trimmed);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
    return undefined;
  }

  /**
   * Put an endpoint in cooldown after an HTTP 429: exponential backoff, but never shorter
   * than a server-advertised `Retry-After` (capped at 1 h).
   */
  private mark429(url: string, retryAfterMs?: number): void {
    const fails = (this.cooldown.get(url)?.fails ?? 0) + 1;
    const expMs = Math.min(this.cooldownBaseMs * 2 ** (fails - 1), this.cooldownMaxMs);
    const waitMs = Math.min(Math.max(expMs, retryAfterMs ?? 0), RETRY_AFTER_CAP_MS);
    this.cooldown.set(url, { until: Date.now() + waitMs, fails });
  }

  private markSuccess(url: string): void {
    this.cooldown.delete(url);
    this.lastHealthy = url;
  }

  /** Exponential retry delay with jitter (delay * 0.5..1.0 so retry waves do not sync up). */
  private retrySleep(attempt: number): Promise<void> {
    if (this.retryDelayMs <= 0) return Promise.resolve();
    const base = this.retryDelayMs * 2 ** attempt;
    return new Promise((ok) => setTimeout(ok, base * (0.5 + Math.random() * 0.5)));
  }

  async fetchJsonRpc<T>(method: string, params: unknown): Promise<T> {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: "snacc-backend", method, params });
    let lastErr: unknown;
    // Bounded per-request attempts (1 initial + RETRY_ATTEMPTS): rotation across endpoints
    // must never turn into an unbounded retry storm against rate-limited public RPC.
    const tried = new Set<string>();
    for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
      const url = this.pickUrl(tried);
      tried.add(url);
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
        if (attempt < RETRY_ATTEMPTS) await this.retrySleep(attempt);
        continue;
      }
      if (res.status === 429) {
        // Rate-limited: this endpoint goes into cooldown (honouring Retry-After), rotate on.
        this.mark429(url, this.retryAfterMs(res));
        lastErr = new RpcError({ code: -32000, message: `HTTP 429 from ${url}` });
        if (attempt < RETRY_ATTEMPTS) await this.retrySleep(attempt);
        continue;
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt < RETRY_ATTEMPTS) {
        // 5xx: rotate to the next endpoint (no cooldown; rotation itself sheds the load).
        lastErr = new RpcError({ code: -32000, message: `HTTP ${res.status} from ${url}` });
        await this.retrySleep(attempt);
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
  ): Promise<ViewResult> {
    const key = `${contractId}:${methodName}:${argsBase64}`;
    const now = Date.now();
    const cached = this.viewCache.get(key);
    if (cached && now - cached.fetchedAt < this.viewCacheTtlMs) {
      this.cacheHits++;
      return { text: cached.text, logs: cached.logs, block_height: cached.block_height };
    }
    // De-dup: simultaneous identical calls share one in-flight RPC request.
    const inflight = this.viewInflight.get(key);
    if (inflight) return inflight;
    const pending = this.fetchView(contractId, methodName, argsBase64, key, cached);
    this.viewInflight.set(key, pending);
    try {
      return await pending;
    } finally {
      this.viewInflight.delete(key);
    }
  }

  private async fetchView(
    contractId: string,
    methodName: string,
    argsBase64: string,
    key: string,
    cached: CacheEntry | undefined,
  ): Promise<ViewResult> {
    this.cacheMisses++;
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
      const out: ViewResult = { text, logs: r.logs, block_height: r.block_height };
      this.viewCache.set(key, { ...out, fetchedAt: Date.now() });
      return out;
    } catch (err) {
      // All endpoints failed (or a non-panic RPC error): serve the stale cache only when it
      // exists and is within the stale window; the response is labelled with its age.
      // Errors are never cached as data.
      const now = Date.now();
      if (
        cached &&
        now - cached.fetchedAt <= this.viewStaleTtlMs &&
        !(err instanceof ViewPanicError)
      ) {
        this.cacheStale++;
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
   * Observability snapshot for `GET /api/health`: current RPC host, per-endpoint cooldown
   * state, and view-cache hit/miss/stale counters. Hosts only — never full URLs or secrets.
   */
  rpcStatus(): RpcStatus {
    const now = Date.now();
    const hostOf = (u: string): string => {
      try {
        return new URL(u).host;
      } catch {
        return "unknown";
      }
    };
    return {
      currentHost: this.lastHealthy !== null ? hostOf(this.lastHealthy) : null,
      endpoints: this.urls.map((u) => {
        const cd = this.cooldown.get(u);
        const until = cd?.until ?? 0;
        const active = until > now;
        return {
          host: hostOf(u),
          cooldownUntil: active ? new Date(until).toISOString() : null,
          cooldownSeconds: active ? Math.ceil((until - now) / 1000) : 0,
          failures: cd?.fails ?? 0,
        };
      }),
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        staleServed: this.cacheStale,
        size: this.viewCache.size,
      },
    };
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
