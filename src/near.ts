/**
 * Klien JSON-RPC NEAR minimal (runtime 0-dependency).
 * `fetchFn` dapat diinjeksi untuk unit test (INT-108).
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

export class NearRpcClient {
  constructor(
    private readonly rpcUrl: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async fetchJsonRpc<T>(method: string, params: unknown): Promise<T> {
    const res = await this.fetchFn(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "snacc-backend",
        method,
        params,
      }),
    });
    if (!res.ok) {
      throw new RpcError({
        code: -32000,
        message: `HTTP ${res.status} dari RPC`,
      });
    }
    const body = (await res.json()) as JsonRpcResponse<T>;
    if (body.error) throw new RpcError(body.error);
    if (body.result === undefined) {
      throw new RpcError({ code: -32603, message: "respons tanpa result" });
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

  /** Panggil view method kontrak; return value NEAR-serialized di-decode ke teks. */
  async viewFunction(
    contractId: string,
    methodName: string,
    argsBase64: string,
  ): Promise<{ text: string; logs: string[]; block_height: number }> {
    const r = await this.fetchJsonRpc<CallFunctionResult>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: methodName,
      args_base64: argsBase64,
    });
    const text = Buffer.from(r.result).toString("utf8");
    return { text, logs: r.logs, block_height: r.block_height };
  }

  chunk(chunkHash: string): Promise<ChunkResult> {
    return this.fetchJsonRpc<ChunkResult>("chunk", { chunk_id: chunkHash });
  }
}

/** True bila error RPC berarti akun/kontrak belum ada (jangan mengarang data). */
export function isContractNotDeployed(err: unknown): boolean {
  if (!(err instanceof RpcError)) return false;
  const s = `${err.rpcError.message} ${JSON.stringify(err.rpcError.data ?? "")}`;
  return (
    s.includes("does not exist while viewing") ||
    s.includes("ContractCodeNotFound") ||
    s.includes("has no contract")
  );
}
