import { playerLockSompi, ProtocolError } from './protocol.js';
import { readAddressUtxos, KaspaCreationConfirmer } from './kaspa-adapter.js';
import { selectOrdinaryUtxos } from './fee-policy.js';
import { estimateFunding } from './funding.mjs';
import { createWasmGenesisSafeJson } from './wasm-transaction.js';
import { blake2b256 } from './hashes/blake2b.mjs';
import { prepareJoinTransaction, serializeJoinTransaction } from './join-transactions.js';
import { prepareWithDynamicFee } from './transaction-fee.js';

const DEFAULT_PRIORITY_BUCKET = 0;

// Gateway between the game use cases and the Kaspa chain. It owns every
// transport concern the use cases should not know about: reading wallet UTXOs,
// estimating priority feerates, constructing WASM SafeJSON, and confirming
// covenant outputs. Use cases depend on this narrow surface instead of the raw
// RPC client.
export class KaspaChainAdapter {
  constructor({ rpc, covenantAddress, scriptPublicKey, outputIndex = 0, confidenceAttempts = 30, confidenceIntervalMs = 2_000, priorityBucket = DEFAULT_PRIORITY_BUCKET }) {
    if (!rpc) throw new ProtocolError('RPC_UNAVAILABLE', 'Kaspa RPC client is required');
    this.rpc = rpc;
    this.covenantAddress = covenantAddress;
    this.scriptPublicKey = scriptPublicKey;
    this.outputIndex = outputIndex;
    this.confidenceAttempts = confidenceAttempts;
    this.confidenceIntervalMs = confidenceIntervalMs;
    this.priorityBucket = priorityBucket;
  }

  async prepareCreation(request) {
    if (!request?.creatorAddress) throw new ProtocolError('INVALID_TRANSACTION', 'Creator address is required');
    if (typeof request?.covenantScriptPublicKey !== 'string' || request.covenantScriptPublicKey.length === 0) {
      throw new ProtocolError('INVALID_TRANSACTION', 'Covenant script public key is required');
    }
    const utxos = await readAddressUtxos({ rpc: this.rpc, addresses: [request.creatorAddress] });
    const entries = Array.isArray(utxos) ? utxos : utxos?.entries ?? [];

    const feerate = await this.#readPriorityFeerate();
    const funding = estimateFunding({ request, entries, feerate });
    const prepared = createWasmGenesisSafeJson({
      request,
      authorizingInput: 0,
      inputs: funding.inputs,
      change: funding.change,
      feerate,
    });

    return Object.freeze({
      network: request.network,
      creatorAddress: request.creatorAddress,
      txJson: prepared.txJson,
      preparedHash: prepared.preparedHash,
      policy: { ...prepared.policy, effectiveFeeSompi: prepared.feeSompi },
      covenantId: prepared.covenantId,
      scriptPublicKey: parseScriptHex(prepared.txJson),
      feeSompi: prepared.feeSompi,
      mass: prepared.mass,
      feerate,
    });
  }

  async confirmCreation({ transactionId, request, prepared }) {
    // The node reports UTXOs with the versioned output script, so match against
    // the versioned SPK the prepared tx actually carries.
    const scriptPublicKey = prepared?.scriptPublicKey ?? this.scriptPublicKey;
    const confirmer = new KaspaCreationConfirmer({
      rpc: this.rpc,
      covenantAddress: this.covenantAddress,
      playerLockSompi: playerLockSompi(request.stakeSompi),
      scriptPublicKey,
      outputIndex: this.outputIndex,
      attempts: this.confidenceAttempts,
      intervalMs: this.confidenceIntervalMs,
    });
    return confirmer.confirmCreation({ transactionId });
  }

  async prepareJoin({ request, game }) {
    const utxos = await readAddressUtxos({ rpc: this.rpc, addresses: [request.joinerAddress] });
    const entries = Array.isArray(utxos) ? utxos : utxos?.entries ?? [];
    const stakeSompi = BigInt(game.stakeSompi ?? game.potSompi);
    const lock = playerLockSompi(stakeSompi);
    const feerate = await this.#readPriorityFeerate();
    const initialFee = BigInt(Math.ceil(Math.max(feerate, 100) * 100_000));
    const selected = selectOrdinaryUtxos({ utxos: entries, targetSompi: lock + initialFee }).selected;
    const selectedEntries = entries.filter((entry) => selected.some((item) => (entry.transactionId ?? entry.outpoint?.transactionId)?.toLowerCase() === item.transactionId && (entry.index ?? entry.outpoint?.index) === item.index));
    const total = selectedEntries.reduce((sum, entry) => sum + BigInt(entry.amount ?? entry.utxo?.amount), 0n);
    const changeScriptPublicKey = request.changeScriptPublicKey ?? selectedEntries[0]?.scriptPublicKey ?? selectedEntries[0]?.utxo?.scriptPublicKey;
    const repriced = prepareWithDynamicFee({
      network: request.network,
      priorityFeerate: feerate,
      fundingSompi: total,
      reservedSompi: lock,
      changeScriptPublicKey,
      build: ({ feeSompi, change }) => prepareJoinTransaction({
        game,
        joinerPublicKey: request.joinerPublicKey,
        joinerCommitment: request.joinerCommitment,
        gameInput: game.currentInput,
        feeInputs: selectedEntries,
        feeSompi,
        change,
        continuationScriptPublicKey: request.continuationScriptPublicKey ?? game.continuationScriptPublicKey,
        continuationCovenant: request.continuationCovenant ?? game.continuationCovenant,
      }),
    });
    const txJson = serializeJoinTransaction(repriced);
    return Object.freeze({
      network: request.network,
      joinerAddress: request.joinerAddress,
      txJson,
      preparedHash: Buffer.from(blake2b256(new TextEncoder().encode(txJson))).toString('hex'),
      feeSompi: repriced.feeSompi,
      mass: repriced.mass,
      feerate,
      gameId: request.gameId,
    });
  }

  async #readPriorityFeerate() {
    if (typeof this.rpc.getFeeEstimate !== 'function') return 0;
    const response = await this.rpc.getFeeEstimate();
    const buckets = response?.estimate?.priorityBucket ?? response?.estimate?.buckets ?? [];
    const bucket = buckets[this.priorityBucket];
    if (!bucket || typeof bucket.feerate !== 'number' || bucket.feerate < 0) return 0;
    return bucket.feerate;
  }
}

function parseScriptHex(txJson) {
  try {
    return JSON.parse(txJson).outputs?.[0]?.scriptPublicKey;
  } catch {
    return undefined;
  }
}
