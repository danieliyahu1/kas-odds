import { ProtocolError } from './protocol.js';
import { DEFAULT_RELAY_FLOOR_RATE } from './fee-policy.js';
import { loadWasmSdk } from './wasm-transaction.js';

const MAX_REPRICING_ROUNDS = 8;

export function prepareWithDynamicFee({ network, priorityFeerate, fundingSompi, reservedSompi = 0n, changeScriptPublicKey, build }) {
  const rate = Math.max(Number(priorityFeerate ?? 0), DEFAULT_RELAY_FLOOR_RATE);
  const reserved = BigInt(reservedSompi);
  let feeSompi = 0n;
  let prepared;

  for (let round = 0; round < MAX_REPRICING_ROUNDS; round += 1) {
    const availableForChange = fundingSompi - reserved;
    const change = availableForChange > feeSompi
      ? { value: availableForChange - feeSompi, scriptPublicKey: changeScriptPublicKey }
      : undefined;
    prepared = build({ feeSompi, change });
    const wasm = loadWasmSdk();
    const transaction = wasm.Transaction.deserializeFromSafeJSON(JSON.stringify(prepared.transaction));
    transaction.finalize();
    const mass = Number(wasm.calculateTransactionMass(network, transaction));
    const repricedFee = BigInt(Math.ceil(mass * rate));
    if (repricedFee === feeSompi) return Object.freeze({ ...prepared, feeSompi, mass, priorityFeerate, relayFloorRate: DEFAULT_RELAY_FLOOR_RATE });
    feeSompi = repricedFee;
  }

  throw new ProtocolError('FEE_REPRICING_FAILED', 'Network fee could not be stabilized for this transaction');
}