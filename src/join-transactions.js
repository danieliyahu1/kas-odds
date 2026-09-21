import { resolveEconomics, ProtocolError } from './protocol.js';
import { buildKccEntrySignatureScript } from './terminal-transactions.js';
import { loadWasmSdk, verifyWasmSignedSafeJson } from './wasm-transaction.js';
import { describeTransactionChanges, unsignedInputs } from './transaction-diagnostics.js';
import { hexToBytes } from './hashes/hex.mjs';

export function prepareJoinTransaction({ game, joinerPublicKey, joinerCommitment, gameInput, feeInputs = [], feeSompi = 0n, change, continuationScriptPublicKey, continuationCovenant }) {
  if (!gameInput || typeof gameInput !== 'object') throw invalid('Current game covenant input is required');
  if (typeof continuationScriptPublicKey !== 'string' || continuationScriptPublicKey.length === 0 || !continuationCovenant) {
    throw invalid('Joined covenant continuation is required');
  }
  const publicKey = bytes(joinerPublicKey, 32, 'joiner public key');
  const commitment = bytes(joinerCommitment, 32, 'joiner commitment');
  const economics = resolveEconomics(game);
  const lock = economics.lockSompi;
  const potValue = economics.potSompi;
  if (typeof feeSompi !== 'bigint' || feeSompi < 0n) throw new ProtocolError('INVALID_FEE', 'Fee must be a non-negative sompi amount');

  const input = normalizeInput({ ...gameInput, amount: lock, covenantId: gameInput.covenantId ?? game.currentCovenantId }, buildKccEntrySignatureScript({
    entry: 'join',
    args: [publicKey, commitment],
    redeemScript: gameInput.redeemScript ?? game.currentRedeemScript,
  }));
  if (!input.utxo.covenantId) throw invalid('Current game input must carry its covenant ID');
  const ordinary = feeInputs.map((entry) => {
    const normalized = normalizeInput(entry, '');
    if (normalized.utxo.covenantId) throw new ProtocolError('FEE_SUBSTITUTION', 'Covenant inputs cannot fund join fees');
    return normalized;
  });
  const totalIn = [input, ...ordinary].reduce((sum, entry) => sum + BigInt(entry.utxo.amount), 0n);
  const output = { value: String(potValue), scriptPublicKey: continuationScriptPublicKey, covenant: continuationCovenant };
  const expectedChange = totalIn - potValue - feeSompi;
  if (expectedChange < 0n) throw new ProtocolError('INSUFFICIENT_UTXOS', 'Joiner inputs cannot fund the matching lock and fee');
  if (expectedChange > 0n && !change?.scriptPublicKey) throw invalid('Change script public key is required');
  if (change !== undefined && BigInt(change.value) !== expectedChange) throw new ProtocolError('FEE_SUBSTITUTION', 'Change does not match the exact fee');
  const changeOutput = expectedChange > 0n ? { value: String(expectedChange), scriptPublicKey: change.scriptPublicKey, covenant: null } : undefined;

  return Object.freeze({
    action: 'join',
    feeSompi,
    transaction: {
      id: '00'.repeat(32), version: 1, inputs: [input, ...ordinary], outputs: [output, ...(changeOutput ? [changeOutput] : [])],
      subnetworkId: '00'.repeat(20), lockTime: '0', gas: '0', storageMass: '0', payload: '',
    },
  });
}

export function serializeJoinTransaction(prepared, wasm = loadWasmSdk()) {
  if (!prepared?.transaction) throw invalid('Prepared join transaction is required');
  try {
    const tx = wasm.Transaction.deserializeFromSafeJSON(JSON.stringify(prepared.transaction));
    tx.finalize();
    return tx.serializeToSafeJSON();
  } catch (error) {
    throw invalid(`WASM rejected join transaction: ${error?.message ?? error}`);
  }
}

export function verifySignedJoinTransaction({ preparedTxJson, signedTxJson }) {
  verifyWasmSignedSafeJson({ preparedTxJson, signedTxJson, policy: {} });
  const prepared = JSON.parse(preparedTxJson);
  const signed = JSON.parse(signedTxJson);
  if (signed.inputs[0]?.signatureScript !== prepared.inputs[0]?.signatureScript) {
    throw new ProtocolError('SIGNED_TRANSACTION_MISMATCH', `Wallet changed the covenant invocation (${describeTransactionChanges(prepared, signed)})`);
  }
  const unsigned = unsignedInputs(signed.inputs, 1);
  if (unsigned.length > 0) {
    throw new ProtocolError('SIGNING_FAILED', `Wallet did not sign every Player B funding input (unsigned ${unsigned.join(',')})`);
  }
  return signedTxJson;
}

function normalizeInput(entry, signatureScript) {
  const transactionId = entry.transactionId ?? entry.outpoint?.transactionId;
  const index = entry.index ?? entry.outpoint?.index;
  if (typeof transactionId !== 'string' || !/^[0-9a-f]{64}$/i.test(transactionId) || !Number.isInteger(index) || index < 0) throw invalid('Join input outpoint is invalid');
  const amount = positive(entry.amount ?? entry.utxo?.amount, 'input amount');
  if (typeof entry.scriptPublicKey !== 'string' || entry.scriptPublicKey.length === 0) throw invalid('Join input script public key is required');
  return { transactionId: transactionId.toLowerCase(), index, sequence: String(entry.sequence ?? 0), sigOpCount: Number(entry.sigOpCount ?? 0), computeBudget: Number(entry.computeBudget ?? 50), signatureScript, utxo: { amount: String(amount), scriptPublicKey: entry.scriptPublicKey, blockDaaScore: String(entry.blockDaaScore ?? entry.utxo?.blockDaaScore ?? 0), isCoinbase: entry.isCoinbase === true || entry.utxo?.isCoinbase === true, ...(entry.covenantId || entry.utxo?.covenantId ? { covenantId: entry.covenantId ?? entry.utxo.covenantId } : {}) } };
}

function bytes(value, length, name) {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/i.test(value)) throw new ProtocolError('INVALID_GAME_STATE', `${name} must be ${length} bytes of hexadecimal`);
  return hexToBytes(value);
}

function positive(value, name) {
  try { const result = typeof value === 'bigint' ? value : BigInt(value); if (result > 0n) return result; } catch {}
  throw invalid(`${name} must be a positive integer`);
}

function invalid(message) { return new ProtocolError('INVALID_TRANSACTION', message); }
