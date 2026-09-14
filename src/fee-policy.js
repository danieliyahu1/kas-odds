import { ProtocolError } from './protocol.js';

// Local transaction-v1 relay-mass floor in sompi per gram (100 sompi/gram).
// This floor ensures the funded fee always covers the consensus compute mass a
// schnorr-signed v1 input requires, well above any idle live feerate.
export const DEFAULT_RELAY_FLOOR_RATE = 100;
export const DEFAULT_MIN_FEE_SOMPI = 0n;
// Consensus charges 100 grams of compute mass per committed compute-budget
// unit on every version-1 input. The wallet-side WASM `calculateTransactionMass`
// ignores the v1 `compute_budget` field (see its "TODO: Add support for v1
// transactions"), so callers must add this term themselves or covenant spends
// whose storage mass is small get under-priced and rejected by the node.
export const GRAMS_PER_COMPUTE_BUDGET_UNIT = 100;

// Sums the consensus compute-mass contribution of the v1 compute budgets on a
// transaction's inputs. Inputs without a budget (v0) contribute nothing.
export function computeBudgetMass(inputs) {
  if (!Array.isArray(inputs)) return 0;
  const units = inputs.reduce((sum, input) => {
    const budget = Number(input?.computeBudget ?? input?.utxo?.computeBudget ?? 0);
    return Number.isFinite(budget) && budget > 0 ? sum + budget : sum;
  }, 0);
  return units * GRAMS_PER_COMPUTE_BUDGET_UNIT;
}
// Conservative upper bound (grams) used to select fee UTXOs before the WASM
// SDK reports the authoritative mass. Empirical SDK mass for a create tx with
// 1-3 funding inputs is ~34k-41k grams; 42k keeps selection safe without
// over-funding.
export const CREATION_MASS_BOUND = 42_000;

export function selectOrdinaryUtxos({ utxos, targetSompi, exclude }) {
  if (!Array.isArray(utxos) || utxos.length === 0) {
    throw new ProtocolError('NO_UTXOS', 'Creator address has no spendable UTXOs');
  }
  const excluded = new Set((exclude ?? []).map(serializeOutpoint));
  const ordinary = utxos
    .filter((entry) => !excluded.has(serializeOutpoint(entry)) && !isCovenantEntry(entry))
    .map(normalizeUtxo)
    .sort((a, b) => (b.amount === a.amount ? compareOutpoints(a, b) : b.amount < a.amount ? -1 : 1));

  if (ordinary.length === 0) {
    throw new ProtocolError('NO_ORDINARY_UTXOS', 'Creator has no ordinary fee-funding UTXOs');
  }

  const selected = [];
  let sum = 0n;
  for (const entry of ordinary) {
    selected.push(entry);
    sum += entry.amount;
    if (sum >= targetSompi) break;
  }
  if (sum < targetSompi) {
    throw new ProtocolError('INSUFFICIENT_UTXOS', 'Creator UTXOs cannot fund the game and fee');
  }
  return { selected: selected.map(toOutpoint), totalSompi: sum, isExact: sum === targetSompi };
}

export function estimateCreationFee({ mass, priorityFeerate, options = {} }) {
  if (!Number.isSafeInteger(mass) || mass <= 0) {
    throw new ProtocolError('INVALID_MASS', 'Transaction mass must be a positive integer of grams');
  }
  const relayFloorRate = Number(options.relayFloorRate ?? DEFAULT_RELAY_FLOOR_RATE);
  const minFee = BigInt(options.minFeeSompi ?? DEFAULT_MIN_FEE_SOMPI);
  if (!Number.isFinite(relayFloorRate) || relayFloorRate < 0 || minFee < 0n) {
    throw new ProtocolError('INVALID_FEE', 'Fee policy constants must be non-negative');
  }

  const priorityRate = normalizePriorityFeerate(priorityFeerate);
  const rate = Math.max(priorityRate, relayFloorRate);
  const rawFee = BigInt(Math.ceil(mass * rate));
  const liveFee = BigInt(Math.ceil(mass * priorityRate));
  const relayFloorFee = BigInt(Math.ceil(mass * relayFloorRate));
  const fee = rawFee > minFee ? rawFee : minFee;
  return { feeSompi: fee, mass, relayFloorFee, liveFee, priorityFeerate: priorityRate, relayFloorRate };
}

function normalizePriorityFeerate(feerate) {
  if (feerate === undefined || feerate === null) return 0;
  const value = Number(feerate);
  if (!Number.isFinite(value) || value < 0) {
    throw new ProtocolError('INVALID_FEE_ESTIMATE', 'Priority feerate must be a non-negative number');
  }
  return value;
}

function isCovenantEntry(entry) {
  const binding = entry?.covenantId ?? entry?.covenant ?? entry?.utxo?.covenantId ?? entry?.utxo?.covenant;
  if (binding === undefined || binding === null) return false;
  if (typeof binding === 'string') return binding !== '';
  return true;
}

function normalizeUtxo(entry) {
  const amount = toBigInt(entry?.amount ?? entry?.utxo?.amount, 'UTXO amount');
  if (amount < 0n) throw new ProtocolError('INVALID_UTXO', 'UTXO amount cannot be negative');
  const txid = entry?.transactionId ?? entry?.utxo?.transactionId ?? entry?.outpoint?.transactionId;
  const index = Number(entry?.index ?? entry?.utxo?.index ?? entry?.outpoint?.index);
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid) || !Number.isInteger(index) || index < 0) {
    throw new ProtocolError('INVALID_UTXO', 'UTXO outpoint must carry a transaction id and index');
  }
  return { transactionId: txid.toLowerCase(), index, amount };
}

function toOutpoint(entry) {
  return { transactionId: entry.transactionId, index: entry.index, amount: entry.amount };
}

function toBigInt(value, name) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new ProtocolError('INVALID_UTXO', `${name} must be a non-negative integer amount`);
}

function serializeOutpoint(entry) {
  if (!entry) return '';
  const txid = entry?.transactionId ?? entry?.utxo?.transactionId ?? entry?.outpoint?.transactionId;
  const index = entry?.index ?? entry?.utxo?.index ?? entry?.outpoint?.index;
  return `${String(txid).toLowerCase()}:${index}`;
}

function compareOutpoints(a, b) {
  if (a.transactionId !== b.transactionId) return a.transactionId < b.transactionId ? -1 : 1;
  return a.index - b.index;
}
