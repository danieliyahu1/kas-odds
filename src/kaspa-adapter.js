import { ProtocolError } from './protocol.js';

export async function submitSignedTransaction({ rpc, transaction, allowOrphan = false }) {
  if (!rpc || typeof rpc.submitTransaction !== 'function') throw new ProtocolError('RPC_UNAVAILABLE', 'Kaspa RPC client is required');
  if (!transaction) throw new ProtocolError('INVALID_TRANSACTION', 'Signed transaction is required');
  const result = await rpc.submitTransaction({ transaction, allowOrphan });
  const transactionId = typeof result === 'string' ? result : result?.transactionId ?? result?.txId;
  if (!transactionId) throw new ProtocolError('SUBMISSION_FAILED', 'Kaspa RPC did not return a transaction identifier');
  return transactionId;
}

export async function readAddressUtxos({ rpc, addresses }) {
  if (!rpc || typeof rpc.getUtxosByAddresses !== 'function') throw new ProtocolError('RPC_UNAVAILABLE', 'Kaspa RPC client is required');
  if (!Array.isArray(addresses) || addresses.length === 0) throw new ProtocolError('INVALID_ADDRESSES', 'At least one address is required');
  return rpc.getUtxosByAddresses(addresses);
}

export class KaspaCreationConfirmer {
  constructor({ rpc, covenantAddress, playerLockSompi, scriptPublicKey, outputIndex = 0, confirmationDepth = 1n, attempts = 30, intervalMs = 2_000, wait = defaultWait }) {
    this.rpc = rpc;
    this.covenantAddress = covenantAddress;
    this.playerLockSompi = playerLockSompi;
    this.scriptPublicKey = scriptPublicKey;
    this.outputIndex = outputIndex;
    this.confirmationDepth = BigInt(confirmationDepth);
    this.attempts = attempts;
    this.intervalMs = intervalMs;
    this.wait = wait;
  }

  async confirmCreation({ transactionId }) {
    let observed = false;
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      const [utxos, dag] = await Promise.all([
        readAddressUtxos({ rpc: this.rpc, addresses: [this.covenantAddress] }),
        this.rpc.getBlockDagInfo(),
      ]);
      const virtualDaaScore = BigInt(dag.virtualDaaScore ?? dag.virtualDaaScoreString ?? 0);
      const entry = (utxos.entries ?? utxos).find((candidate) => {
        const id = candidate.outpoint?.transactionId ?? candidate.transactionId;
        const index = candidate.outpoint?.index ?? candidate.index;
        const script = candidate.scriptPublicKey?.script ?? candidate.scriptPublicKey;
        return id === transactionId
          && index === this.outputIndex
          && BigInt(candidate.amount) === this.playerLockSompi
          && (!this.scriptPublicKey || script === this.scriptPublicKey);
      });
      if (entry && isMinedDaaScore(entry.blockDaaScore) && virtualDaaScore >= BigInt(entry.blockDaaScore) + this.confirmationDepth) {
        return {
          status: 'confirmed',
          acceptingDaaScore: String(entry.blockDaaScore),
          confirmedDaaScore: String(virtualDaaScore),
        };
      }
      observed ||= Boolean(entry);
      if (attempt + 1 < this.attempts) await this.wait(this.intervalMs);
    }
    return { status: observed ? 'observed' : 'stale' };
  }
}

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// The node reports a UTXO it only knows from the mempool with block DAA score 0.
// It is visible but not yet mined, so it cannot anchor a chained spend.
export function isMinedDaaScore(blockDaaScore) {
  try {
    return BigInt(blockDaaScore ?? 0) > 0n;
  } catch {
    return false;
  }
}
