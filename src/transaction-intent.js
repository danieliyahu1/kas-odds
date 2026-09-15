import { ProtocolError } from './protocol.js';

const ACTIONS = new Set(['creation', 'join', 'reveal', 'refund', 'refund_all', 'fallback_claim']);

// This verifier deliberately works on SafeJSON-shaped plain objects so the same
// intent checks can run in the browser before KasWare and on the server after it.
export function verifyTransactionIntent({ action, txJson, intent }) {
  if (!ACTIONS.has(action)) throw invalid(`Unsupported transaction action: ${action}`);
  const transaction = parseTransaction(txJson);
  const expected = intent ?? {};
  const covenantInputIndex = expected.covenantInputIndex ?? 0;
  const covenantInput = transaction.inputs?.[covenantInputIndex];
  if (!covenantInput) throw invalid('The transaction is missing its covenant input');

  assertInput(covenantInput, expected.covenantInput, 'covenant input');
  if (expected.lockTime !== undefined && String(transaction.lockTime) !== String(expected.lockTime)) {
    throw mismatch('Transaction lock time does not match the requested action');
  }
  if (expected.sequence !== undefined && String(covenantInput.sequence) !== String(expected.sequence)) {
    throw mismatch('Covenant input sequence does not match the requested action');
  }

  const fixedOutputs = expected.fixedOutputs;
  if (!Array.isArray(fixedOutputs) || fixedOutputs.length === 0) {
    throw invalid('Complete transaction output intent is required');
  }
  if (transaction.outputs.length < fixedOutputs.length || transaction.outputs.length > fixedOutputs.length + 1) {
    throw mismatch('Transaction contains an unexpected number of outputs');
  }
  fixedOutputs.forEach((output, index) => assertOutput(transaction.outputs[index], output, `output ${index}`));

  const totalIn = transaction.inputs.reduce((sum, input) => sum + amount(input?.utxo?.amount, 'input amount'), 0n);
  const fixedTotal = fixedOutputs.reduce((sum, output) => sum + amount(output.value, 'expected output value'), 0n);
  const fee = amount(expected.feeSompi, 'expected fee');
  const expectedChange = totalIn - fixedTotal - fee;
  if (expectedChange < 0n) throw mismatch('Transaction outputs exceed the requested inputs and fee');

  if (expectedChange === 0n && transaction.outputs.length !== fixedOutputs.length) {
    throw mismatch('Transaction contains an unexpected change output');
  }
  if (expectedChange > 0n) {
    if (transaction.outputs.length !== fixedOutputs.length + 1) throw mismatch('Transaction is missing its exact change output');
    const change = transaction.outputs.at(-1);
    if (change.scriptPublicKey !== expected.changeScriptPublicKey || change.covenant !== null) {
      throw mismatch('Change output does not return to the approved script');
    }
    if (String(change.value) !== String(expectedChange)) throw mismatch('Change output does not match the exact fee');
  }
  if (totalIn - transaction.outputs.reduce((sum, output) => sum + amount(output?.value, 'output value'), 0n) !== fee) {
    throw mismatch('Transaction fee does not match the requested fee');
  }

  const signInputs = [];
  transaction.inputs.forEach((input, index) => {
    const signatureScript = input.signatureScript;
    if (index === covenantInputIndex) {
      if (typeof signatureScript !== 'string' || signatureScript.length === 0) throw invalid('Covenant input invocation is missing');
      return;
    }
    if (input.utxo?.covenantId) throw mismatch('Covenant inputs cannot be used as wallet funding inputs');
    if (signatureScript !== '') throw mismatch(`Wallet input ${index} must be unsigned before signing`);
    signInputs.push({ index, sighashType: 1 });
  });
  if (signInputs.length === 0) throw invalid('Transaction has no wallet funding inputs');
  if (Array.isArray(expected.signingInputIndexes)
    && JSON.stringify(signInputs.map(({ index }) => index)) !== JSON.stringify(expected.signingInputIndexes)) {
    throw mismatch('Verified wallet signing inputs do not match the requested action');
  }
  return Object.freeze({ transaction, signInputs });
}

export function createTransactionIntent({ action, txJson, feeSompi }) {
  const transaction = parseTransaction(txJson);
  const input = transaction.inputs?.[0];
  if (!input) throw invalid('The transaction is missing its covenant input');
  return Object.freeze({
    action,
    covenantInput: {
      transactionId: input.transactionId,
      index: input.index,
      amount: input.utxo?.amount,
      scriptPublicKey: input.utxo?.scriptPublicKey,
      covenantId: input.utxo?.covenantId,
      signatureScript: input.signatureScript,
    },
    sequence: input.sequence,
    fixedOutputs: transaction.outputs,
    feeSompi: String(feeSompi),
    signingInputIndexes: transaction.inputs
      .map((entry, index) => (index > 0 && entry.signatureScript === '' ? index : null))
      .filter((index) => index !== null),
  });
}

function assertInput(actual, expected, name) {
  if (!expected) throw invalid('Complete covenant input intent is required');
  const actualOutpoint = `${actual.transactionId}:${actual.index}`;
  const expectedOutpoint = `${expected.transactionId}:${expected.index}`;
  if (actualOutpoint.toLowerCase() !== expectedOutpoint.toLowerCase()
    || String(actual.utxo?.amount) !== String(expected.amount)
    || actual.utxo?.scriptPublicKey !== expected.scriptPublicKey
    || (expected.covenantId !== undefined && String(actual.utxo?.covenantId ?? '').toLowerCase() !== String(expected.covenantId).toLowerCase())
    || (expected.signatureScript !== undefined && actual.signatureScript !== expected.signatureScript)) {
    throw mismatch(`${name} does not match the requested game UTXO`);
  }
}

function assertOutput(actual, expected, name) {
  if (!actual || String(actual.value) !== String(expected.value)
    || actual.scriptPublicKey !== expected.scriptPublicKey
    || JSON.stringify(actual.covenant ?? null) !== JSON.stringify(expected.covenant ?? null)) {
    throw mismatch(`${name} does not match the requested transaction intent`);
  }
}

function parseTransaction(value) {
  try {
    const transaction = typeof value === 'string' ? JSON.parse(value) : value;
    if (!transaction || typeof transaction !== 'object' || !Array.isArray(transaction.inputs) || !Array.isArray(transaction.outputs)) throw new Error();
    return transaction;
  } catch {
    throw invalid('SafeJSON must contain one transaction object');
  }
}

function amount(value, name) {
  try {
    const result = BigInt(value);
    if (result >= 0n) return result;
  } catch {}
  throw invalid(`${name} must be a non-negative integer`);
}

function invalid(message) {
  return new ProtocolError('INVALID_TRANSACTION', message);
}

function mismatch(message) {
  return new ProtocolError('SIGNED_TRANSACTION_MISMATCH', message);
}
