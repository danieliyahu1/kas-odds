// Kaspa wRPC client for the pinned v2.0.1 SDK, used by the backend to read the
// chain and broadcast transactions. The browser never talks to the node
// directly; all chain communication is server-side.
import { ProtocolError } from './protocol.js';
import { isSupportedNetwork } from './network.js';
import { loadWasmSdk, initWasmSdk } from './wasm-loader.mjs';

const DEFAULT_NODE_URL = typeof process !== 'undefined' ? process?.env?.KASPA_WRPC_URL : undefined;
const MAX_RECONNECT_RETRIES = 3;

export class WrpcClient {
  constructor({ network, url = DEFAULT_NODE_URL } = {}) {
    if (!isSupportedNetwork(network)) throw new ProtocolError('WRONG_NETWORK', 'Unsupported Kaspa network');
    this.network = network;
    this.url = url;
    this.rpc = null;
    this.connecting = null;
  }

  async connect() {
    if (this.rpc) return this;
    if (!this.connecting) this.connecting = this.#connect();
    try {
      await this.connecting;
      return this;
    } finally {
      this.connecting = null;
    }
  }

  async disconnect() {
    const rpc = this.rpc;
    this.rpc = null;
    if (rpc) await rpc.disconnect();
  }

  async getBlockDagInfo() {
    const response = await this.#read((rpc) => rpc.getBlockDagInfo());
    return response?.toJSON ? response.toJSON() : response;
  }

  async getUtxosByAddresses(addresses) {
    const response = await this.#read((rpc) => rpc.getUtxosByAddresses(addresses));
    const entries = (response?.entries ?? response).map(normalizeUtxoEntry);
    return { entries };
  }

  async getFeeEstimate() {
    const response = await this.#read((rpc) => rpc.getFeeEstimate());
    const priority = response?.estimate?.priorityBucket;
    return { estimate: { priorityBucket: Array.isArray(priority) ? priority : [priority].filter(Boolean) } };
  }

  async submitSafeJson(signedTxJson) {
    const kaspa = loadWasmSdk();
    let transaction;
    try {
      transaction = kaspa.Transaction.deserializeFromSafeJSON(signedTxJson);
    } catch {
      throw new ProtocolError('INVALID_TRANSACTION', 'Signed transaction is not valid Kaspa SafeJSON');
    }
    try {
      const response = await (await this.#rpc()).submitTransaction({ transaction, allowOrphan: false });
      return response?.transactionId ?? response?.txId ?? response;
    } catch (error) {
      if (isDisconnectedError(error)) {
        await this.#resetConnection();
        throw internalRpcError(error);
      }
      throw new ProtocolError(
        'TRANSACTION_REJECTED',
        'The network did not accept this transaction. Wait a few seconds and try again. Your game funds remain safe.',
        { cause: error },
      );
    }
  }

  async #rpc() {
    await this.connect();
    return this.rpc;
  }

  async #read(operation) {
    let lastError;
    try {
      return await operation(await this.#rpc());
    } catch (error) {
      if (!isDisconnectedError(error)) throw error;
      lastError = error;
    }
    for (let retry = 0; retry < MAX_RECONNECT_RETRIES; retry += 1) {
      await this.#resetConnection();
      try {
        return await operation(await this.#rpc());
      } catch (error) {
        if (!isDisconnectedError(error)) throw error;
        lastError = error;
      }
    }
    throw internalRpcError(lastError);
  }

  async #resetConnection() {
    const rpc = this.rpc;
    this.rpc = null;
    if (rpc) await rpc.disconnect().catch(() => {});
  }


  async #connect() {
    if (!loadWasmSdkSafe()) await initWasmSdk();
    const kaspa = loadWasmSdk();
    const url = this.url ?? await new kaspa.Resolver().getUrl(kaspa.Encoding.Borsh, this.network);
    const rpc = new kaspa.RpcClient({ url, networkId: this.network, encoding: kaspa.Encoding.Borsh });
    await rpc.connect({ timeoutDuration: 10_000, retryInterval: 1_000 });
    this.url = url;
    this.rpc = rpc;
  }
}

export function isDisconnectedError(error) {
  const message = String(error?.message ?? error ?? '').toLowerCase();
  return /not connected|connection (?:closed|lost|refused|reset)|websocket.*(?:closed|disconnected|not connected)|socket.*(?:closed|disconnected|not connected)|failed to connect|unable to connect|econnrefused|timed out|timeout/.test(message);
}

function internalRpcError(cause) {
  const error = new Error('Kaspa network connection failed after three retries');
  error.code = 'INTERNAL_ERROR';
  error.cause = cause;
  return error;
}

function loadWasmSdkSafe() {
  try {
    return Boolean(loadWasmSdk());
  } catch {
    return false;
  }
}

export function normalizeUtxoEntry(entry) {
  const value = entry.entry ?? entry;
  return {
    ...value,
    outpoint: entry.outpoint ?? value.outpoint,
    amount: value.amount,
    scriptPublicKey: encodeScriptPublicKey(value.scriptPublicKey),
    blockDaaScore: value.blockDaaScore,
    isCoinbase: value.isCoinbase,
    covenantId: encodeCovenantId(value.covenantId),
  };
}

// The WASM UTXO entry exposes its covenant id as a `Hash` object with a hex
// `toString()` and no `toJSON()`, so it would serialize to `{}` (a map) inside
// a SafeJSON transaction. Normalize it to the hex string the SafeJSON expects.
function encodeCovenantId(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value;
  return value.toString();
}

function encodeScriptPublicKey(value) {
  if (typeof value === 'string') return value;
  const version = Number(value?.version ?? 0).toString(16).padStart(4, '0');
  return `${version}${value?.script ?? ''}`;
}
