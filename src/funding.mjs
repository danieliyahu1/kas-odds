// Isomorphic funding estimation for covenant transactions. Selects ordinary
// (non-covenant) wallet UTXOs to cover the stake and fee, and reports the
// change output. Used by the Node chain adapter and by the browser client.
import { ProtocolError, covenantValueSompi } from './protocol.js';
import { estimateCreationFee, selectOrdinaryUtxos, CREATION_MASS_BOUND } from './fee-policy.js';

export function estimateFunding({ request, entries, feerate, feeOptions }) {
  const lock = covenantValueSompi(request);
  const committedFee = request.feeSompi;
  if (typeof committedFee !== 'bigint' || committedFee < 0n) {
    throw new ProtocolError('INVALID_FEE', 'Committed fee must be non-negative sompi');
  }

  const changeScriptPublicKey = feeOptions?.changeScriptPublicKey;
  const raw = entries.map(normalizeEntry);

  // Select fee inputs against a conservative mass upper bound so the chosen
  // UTXOs always cover the WASM-authoritative consensus mass the final tx
  // charges. The exact fee is recomputed from the SDK after building.
  const policyFee = estimateCreationFee({ mass: CREATION_MASS_BOUND, priorityFeerate: feerate, options: feeOptions }).feeSompi;
  const effectiveFee = policyFee > committedFee ? policyFee : committedFee;
  const target = lock + effectiveFee;

  const { selected, totalSompi } = selectOrdinaryUtxos({ utxos: entries, targetSompi: target });
  const fundingInputs = raw.filter((entry) => selected.some((s) => s.transactionId === entry.transactionId && s.index === entry.index));
  const changeValue = totalSompi - target;
  const change = changeValue > 0n
    ? { value: changeValue, scriptPublicKey: changeScriptPublicKey ?? fundingInputs[0].scriptPublicKey }
    : undefined;
  const mass = estimateMass(fundingInputs.length, change ? 2 : 1, fundingInputs);

  return {
    inputs: fundingInputs,
    change,
    feeSompi: effectiveFee,
    committedFee,
    mass,
    totalSompi,
  };
}

export function normalizeEntry(entry) {
  const txid = entry?.transactionId ?? entry?.utxo?.transactionId ?? entry?.outpoint?.transactionId;
  const index = entry?.index ?? entry?.utxo?.index ?? entry?.outpoint?.index;
  const amount = entry?.amount ?? entry?.utxo?.amount;
  const script = toScriptHex(entry?.scriptPublicKey ?? entry?.utxo?.scriptPublicKey);
  return {
    transactionId: typeof txid === 'string' ? txid.toLowerCase() : txid,
    index,
    amount: toAmountBigInt(amount),
    scriptPublicKey: script,
    blockDaaScore: entry?.blockDaaScore ?? entry?.utxo?.blockDaaScore ?? 0n,
    isCoinbase: entry?.isCoinbase ?? entry?.utxo?.isCoinbase ?? false,
  };
}

export function estimateMass(inputCount, outputCount, inputs = []) {
  const perInput = 41 + 8;
  const scriptGrams = inputs.reduce((sum, input) => sum + hexByteLength(input?.scriptPublicKey), 0);
  const outputGrams = (outputCount ?? 1) * 47;
  return Math.max(101, Math.ceil(perInput * inputCount + scriptGrams + outputGrams));
}

function toAmountBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new ProtocolError('INVALID_UTXO', 'UTXO amount must be a non-negative integer');
}

function toScriptHex(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.script === 'string') {
    return toScriptHex(value.script);
  }
  return '';
}

function hexByteLength(value) {
  if (typeof value !== 'string') return 0;
  return Math.floor(value.length / 2);
}
