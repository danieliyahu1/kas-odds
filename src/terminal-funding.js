import { ProtocolError } from './protocol.js';
import { DEFAULT_NETWORK_PROFILE } from './network.js';
import { selectOrdinaryUtxos } from './fee-policy.js';
import { loadWasmSdk } from './wasm-transaction.js';
import { prepareWithDynamicFee } from './transaction-fee.js';

const MAX_TERMINAL_STORAGE_MASS = 500_000;

export class TerminalFundingSelector {
  constructor({ chain, network = DEFAULT_NETWORK_PROFILE.id }) {
    if (!chain || typeof chain.getUtxos !== 'function' || typeof chain.getPriorityFeerate !== 'function') {
      throw new ProtocolError('CHAIN_UNAVAILABLE', 'A chain gateway with funding capabilities is required');
    }
    this.chain = chain;
    this.network = network;
  }

  async select(address, measure) {
    const response = await this.chain.getUtxos(address);
    const entries = response.entries ?? response;
    const ordinary = entries.filter((entry) => !entry.covenantId);
    if (ordinary.length === 0) selectOrdinaryUtxos({ utxos: entries, targetSompi: 1n });
    const candidates = fundingCandidates(ordinary, 1n);
    if (candidates.length === 0) selectOrdinaryUtxos({ utxos: entries, targetSompi: 1n });
    const priorityFeerate = await this.chain.getPriorityFeerate();
    let best;
    let bestMass = Number.POSITIVE_INFINITY;
    let sawMassFailure = false;
    let lastFundingError;
    for (const inputs of candidates) {
      const total = inputs.reduce((sum, entry) => sum + BigInt(entry.amount), 0n);
      try {
        const changeScriptPublicKey = inputs[0].scriptPublicKey ?? inputs[0].utxo?.scriptPublicKey;
        const repriced = prepareWithDynamicFee({
          network: this.network,
          priorityFeerate,
          fundingSompi: total,
          changeScriptPublicKey,
          build: ({ feeSompi, change }) => measure({ inputs, feeSompi, change }),
        });
        const mass = terminalStorageMass(repriced.transaction, this.network);
        if (mass <= MAX_TERMINAL_STORAGE_MASS && mass < bestMass) {
          best = {
            inputs,
            feeSompi: repriced.feeSompi,
            mass: repriced.mass,
            assumedSignedInputs: repriced.assumedSignedInputs,
            priorityFeerate,
            change: total > repriced.feeSompi ? { value: total - repriced.feeSompi, scriptPublicKey: changeScriptPublicKey } : undefined,
          };
          bestMass = mass;
        } else {
          sawMassFailure = true;
        }
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        lastFundingError = error;
      }
    }
    if (best) return best;
    if (!sawMassFailure && lastFundingError) throw lastFundingError;
    throw new ProtocolError('STORAGE_MASS_EXCEEDED', `No fee UTXO combination keeps this transaction below the ${MAX_TERMINAL_STORAGE_MASS} storage-mass limit`);
  }
}

function terminalStorageMass(transaction, network) {
  const wasm = loadWasmSdk();
  return Number(wasm.calculateStorageMass(
    network,
    transaction.inputs.map((input) => Number(input.utxo.amount)),
    transaction.outputs.map((output) => Number(output.value)),
  ));
}

function fundingCandidates(entries, targetSompi) {
  const byOutpoint = (entry) => {
    const outpoint = entry.outpoint ?? entry;
    return `${outpoint.transactionId.toLowerCase()}:${outpoint.index}`;
  };
  const byAmount = (a, b) => {
    const amount = BigInt(a.amount) === BigInt(b.amount) ? 0 : BigInt(a.amount) > BigInt(b.amount) ? 1 : -1;
    return amount !== 0 ? amount : byOutpoint(a).localeCompare(byOutpoint(b));
  };
  const pool = [...entries].sort(byAmount).slice(0, 10);
  const candidates = [];
  const seen = new Set();
  const consider = (selected) => {
    if (selected.reduce((sum, entry) => sum + BigInt(entry.amount), 0n) < targetSompi) return;
    const key = selected.map(byOutpoint).sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(selected);
  };
  for (const entry of pool) consider([entry]);
  for (let size = 2; size <= 4 && candidates.length < 600; size += 1) {
    for (let a = 0; a < pool.length && candidates.length < 600; a += 1) {
      for (let b = a + 1; b < pool.length && candidates.length < 600; b += 1) {
        if (size === 2) { consider([pool[a], pool[b]]); continue; }
        for (let c = b + 1; c < pool.length && candidates.length < 600; c += 1) {
          if (size === 3) { consider([pool[a], pool[b], pool[c]]); continue; }
          for (let d = c + 1; d < pool.length && candidates.length < 600; d += 1) consider([pool[a], pool[b], pool[c], pool[d]]);
        }
      }
    }
  }
  try {
    const { selected } = selectOrdinaryUtxos({ utxos: entries, targetSompi });
    consider(entries.filter((entry) => selected.some((item) => {
      const outpoint = entry.outpoint ?? entry;
      return outpoint.transactionId.toLowerCase() === item.transactionId && outpoint.index === item.index;
    })));
  } catch {
    // The caller produces the typed funding error.
  }
  return candidates;
}
