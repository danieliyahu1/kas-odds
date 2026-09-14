import { DEFAULT_RELAY_FLOOR_RATE, computeBudgetMass } from './fee-policy.js';
import { ProtocolError } from './protocol.js';
import { loadWasmSdk } from './wasm-loader.mjs';

// KasWare signs ordinary P2PK inputs with OP_DATA_65 followed by a 64-byte
// Schnorr signature and one sighash byte.
const KASWARE_SIGNATURE_SCRIPT = `41${'00'.repeat(65)}`;

export function estimateSignedTransactionMass(network, transaction) {
  const assumedSigned = structuredClone(transaction);
  let assumedSignedInputs = 0;
  for (const input of assumedSigned.inputs ?? []) {
    if (input.signatureScript !== '') continue;
    input.signatureScript = KASWARE_SIGNATURE_SCRIPT;
    assumedSignedInputs += 1;
  }
  return {
    mass: calculateMass(network, assumedSigned),
    assumedSignedInputs,
  };
}

export function signedTransactionFeeDiagnostics({ network, signedTxJson, priorityFeerate = 0 }) {
  const transaction = parseTransaction(signedTxJson);
  const mass = calculateMass(network, transaction);
  const effectiveFeeRate = Math.max(Number(priorityFeerate ?? 0), DEFAULT_RELAY_FLOOR_RATE);
  const paidFeeSompi = sumInputs(transaction) - sumOutputs(transaction);
  const requiredFeeSompi = BigInt(Math.ceil(mass * effectiveFeeRate));
  return Object.freeze({
    mass,
    effectiveFeeRate,
    paidFeeSompi,
    requiredFeeSompi,
    inputCount: transaction.inputs.length,
    outputCount: transaction.outputs.length,
    signedInputCount: transaction.inputs.filter((input) => input.signatureScript !== '').length,
  });
}

export function assertSignedTransactionFee(options) {
  const diagnostics = signedTransactionFeeDiagnostics(options);
  if (diagnostics.paidFeeSompi < diagnostics.requiredFeeSompi) {
    const error = new ProtocolError(
      'INSUFFICIENT_TRANSACTION_FEE',
      'The signed transaction fee is below the required network fee. Prepare and sign the transaction again.',
    );
    error.transactionDiagnostics = diagnostics;
    throw error;
  }
  return diagnostics;
}

function calculateMass(network, transactionJson) {
  const wasm = loadWasmSdk();
  try {
    const transaction = wasm.Transaction.deserializeFromSafeJSON(JSON.stringify(transactionJson));
    transaction.finalize();
    return Number(wasm.calculateTransactionMass(network, transaction)) + computeBudgetMass(transactionJson.inputs);
  } catch (error) {
    throw new ProtocolError('INVALID_TRANSACTION', `WASM could not calculate transaction mass: ${error?.message ?? error}`);
  }
}

function parseTransaction(value) {
  try {
    const transaction = typeof value === 'string' ? JSON.parse(value) : structuredClone(value);
    if (!transaction || !Array.isArray(transaction.inputs) || !Array.isArray(transaction.outputs)) throw new Error();
    return transaction;
  } catch {
    throw new ProtocolError('INVALID_TRANSACTION', 'SafeJSON must contain one transaction object');
  }
}

function sumInputs(transaction) {
  return transaction.inputs.reduce((sum, input) => sum + amount(input?.utxo?.amount), 0n);
}

function sumOutputs(transaction) {
  return transaction.outputs.reduce((sum, output) => sum + amount(output?.value), 0n);
}

function amount(value) {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'bigint' && value >= 0n) return value;
  throw new ProtocolError('INVALID_TRANSACTION', 'Transaction amounts must be non-negative integers');
}
