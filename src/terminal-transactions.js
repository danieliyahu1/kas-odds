import { playerLockSompi, grossPotSompi, gameFeeSompi, winnerPayoutSompi, automaticFallbackPayoutSompi, AUTOMATION_FEE_SOMPI, ProtocolError } from './protocol.js';
import { getCovenantTemplate } from './covenant/template.mjs';
import { hexToBytes, bytesToHex } from './hashes/hex.mjs';
import {
  FALLBACK_CLAIM_DAA_OFFSET,
  NO_REVEAL_REFUND_DAA_OFFSET,
  resolveFallbackClaim,
  resolveIndividualRefund,
} from './terminal-actions.js';
import { parityOutcome, resolveReveal, verifyRevealPreimage } from './reveal.js';
import { loadWasmSdk, verifyWasmSignedSafeJson } from './wasm-transaction.js';
import { describeTransactionChanges, unsignedInputs } from './transaction-diagnostics.js';

export const TERMINAL_ENTRIES = Object.freeze({
  reveal: 'reveal',
  fallbackClaim: 'fallback_claim',
  refund: 'refund',
  refundOpen: 'refund_open',
  refundAll: 'refund_all',
});

export function buildKccEntrySignatureScript({ entry, args, redeemScript, wasm = loadWasmSdk() }) {
  const dispatchTag = getCovenantTemplate().dispatchTags?.[entry];
  if (!dispatchTag) throw new ProtocolError('INVALID_TRANSACTION', `Unknown Even/Odd entry ${entry}`);
  if (!Array.isArray(args)) throw new ProtocolError('INVALID_TRANSACTION', 'KCC entry arguments are required');

  const builder = new wasm.ScriptBuilder();
  for (const arg of args) addArgument(builder, arg);
  builder.addData(hexToBytes(dispatchTag));
  const invocation = builder.drain();
  return redeemScript === undefined ? invocation : invocation + pushScriptData(redeemScript);
}

export function prepareFallbackClaimTransaction({ game, caller, currentDaaScore, gameInput, recipientScriptPublicKey, feeInputs = [], feeSompi = 0n, change, publicKey, walletPublicKey, feeScriptPublicKey }) {
  const decision = resolveFallbackClaim({ game, caller, currentDaaScore });
  if (!decision.available) throw new ProtocolError('ACTION_UNAVAILABLE', decision.message);
  if (typeof walletPublicKey !== 'string' || walletPublicKey.length === 0) throw new ProtocolError('INVALID_TRANSACTION', 'Game wallet public key is required');
  const gameFee = gameFeeSompi(game.stakeSompi);
  if (gameFee > 0n && (typeof feeScriptPublicKey !== 'string' || feeScriptPublicKey.length === 0)) throw new ProtocolError('INVALID_TRANSACTION', 'Game fee script public key is required');
  return prepareCovenantOnlyTransaction({
    action: TERMINAL_ENTRIES.fallbackClaim,
    gameInput,
    inputSequence: FALLBACK_CLAIM_DAA_OFFSET,
    args: [publicKey, walletPublicKey],
    outputs: [
      { value: automaticFallbackPayoutSompi(game.stakeSompi), scriptPublicKey: recipientScriptPublicKey },
      ...(gameFee > 0n ? [{ value: gameFee, scriptPublicKey: feeScriptPublicKey }] : []),
    ],
  });
}

export function prepareRefundAllTransaction({ gameInput, stakeSompi, creatorPublicKey, joinerPublicKey }) {
  const stake = playerLockSompi(BigInt(stakeSompi));
  return prepareCovenantOnlyTransaction({
    action: TERMINAL_ENTRIES.refundAll,
    gameInput,
    inputSequence: NO_REVEAL_REFUND_DAA_OFFSET,
    args: [creatorPublicKey, joinerPublicKey],
    outputs: [
      { value: stake - AUTOMATION_FEE_SOMPI / 2n, scriptPublicKey: playerScriptPublicKey(creatorPublicKey) },
      { value: stake - AUTOMATION_FEE_SOMPI / 2n, scriptPublicKey: playerScriptPublicKey(joinerPublicKey) },
    ],
  });
}

export function prepareOpenRefundTransaction({ gameInput, stakeSompi, settleFeeSompi, deadlineDaa, creatorPublicKey }) {
  const stake = playerLockSompi(BigInt(stakeSompi));
  const fee = BigInt(settleFeeSompi);
  if (fee <= 0n || fee >= stake) throw new ProtocolError('INVALID_TRANSACTION', 'Open refund fee must be smaller than the stake');
  return prepareCovenantOnlyTransaction({
    action: TERMINAL_ENTRIES.refundOpen,
    gameInput,
    inputSequence: NO_REVEAL_REFUND_DAA_OFFSET,
    lockTime: BigInt(deadlineDaa),
    args: [creatorPublicKey],
    outputs: [{ value: stake - fee, scriptPublicKey: playerScriptPublicKey(creatorPublicKey) }],
  });
}

export function prepareRevealTransaction({ game, caller, currentDaaScore, secret, gameInput, recipientScriptPublicKey, continuationScriptPublicKey, continuationCovenant, feeInputs = [], feeSompi = 0n, change, publicKey, payoutPublicKey = publicKey, walletPublicKey, feeScriptPublicKey }) {
  const decision = resolveReveal({ game, caller, currentDaaScore, secret });
  if (!decision.available) throw new ProtocolError('ACTION_UNAVAILABLE', decision.message);
  const isFirstReveal = !game.firstReveal;
  if (isFirstReveal && (typeof continuationScriptPublicKey !== 'string' || continuationScriptPublicKey.length === 0 || !continuationCovenant)) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Reveal continuation script public key is required');
  }
  const gameFee = isFirstReveal ? 0n : gameFeeSompi(game.stakeSompi);
  if (!isFirstReveal && (typeof recipientScriptPublicKey !== 'string' || recipientScriptPublicKey.length === 0 || (gameFee > 0n && (typeof feeScriptPublicKey !== 'string' || feeScriptPublicKey.length === 0)))) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Winner and game fee script public keys are required');
  }
  if (typeof walletPublicKey !== 'string' || walletPublicKey.length === 0) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Game wallet public key is required');
  }
  const revealArgs = [publicKey, { type: 'int', value: decision.choice }, decision.nonceHex, payoutPublicKey, walletPublicKey];
  if (isFirstReveal) {
    const continued = grossPotSompi(game.stakeSompi);
    return prepareTerminalTransaction({
      action: TERMINAL_ENTRIES.reveal,
      gameInput,
      args: revealArgs,
      payoutValue: continued,
      recipientScriptPublicKey: continuationScriptPublicKey,
      extraOutputs: [{ value: continued, scriptPublicKey: continuationScriptPublicKey, covenant: continuationCovenant }],
      omitPrimaryOutput: true,
      feeInputs,
      feeSompi,
      change,
    });
  }
  return prepareTerminalTransaction({
    action: TERMINAL_ENTRIES.reveal,
    gameInput,
    args: revealArgs,
    payoutValue: winnerPayoutSompi(game.stakeSompi),
    recipientScriptPublicKey,
    extraOutputs: gameFee > 0n ? [{ value: gameFee, scriptPublicKey: feeScriptPublicKey }] : [],
    feeInputs,
    feeSompi,
    change,
  });
}

export function prepareIndividualRefundTransaction({ game, caller, currentDaaScore, gameInput, recipientScriptPublicKey, continuationScriptPublicKey, continuationCovenant, feeInputs = [], feeSompi = 0n, change, publicKey }) {
  const decision = resolveIndividualRefund({ game, caller, currentDaaScore });
  if (!decision.available) throw new ProtocolError('ACTION_UNAVAILABLE', decision.message);
  const refund = playerLockSompi(game.stakeSompi);
  const requiresContinuation = !Object.values(game.refunds ?? {}).some(Boolean);
  if (requiresContinuation && (typeof continuationScriptPublicKey !== 'string' || continuationScriptPublicKey.length === 0 || !continuationCovenant)) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Refund continuation script public key is required');
  }
  return prepareTerminalTransaction({
    action: TERMINAL_ENTRIES.refund,
    gameInput,
    inputSequence: NO_REVEAL_REFUND_DAA_OFFSET,
    args: [publicKey],
    payoutValue: refund,
    recipientScriptPublicKey,
    extraOutputs: requiresContinuation ? [{ value: refund, scriptPublicKey: continuationScriptPublicKey, covenant: continuationCovenant }] : [],
    feeInputs,
    feeSompi,
    change,
  });
}

export function prepareTerminalTransaction({ action, gameInput, inputSequence = 0n, lockTime = 0n, args, payoutValue, recipientScriptPublicKey, extraOutputs = [], feeInputs = [], feeSompi = 0n, change, omitPrimaryOutput = false }) {
  if (!gameInput || typeof gameInput !== 'object') throw new ProtocolError('INVALID_TRANSACTION', 'Current game UTXO is required');
  if (!omitPrimaryOutput && (typeof recipientScriptPublicKey !== 'string' || recipientScriptPublicKey.length === 0)) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Recipient script public key is required');
  }
  if (typeof feeSompi !== 'bigint' || feeSompi < 0n) throw new ProtocolError('INVALID_FEE', 'Fee must be a non-negative sompi amount');
  if (feeInputs.length === 0) throw new ProtocolError('INVALID_TRANSACTION', 'A signed player funding input is required');
  const input = normalizeInput({ ...gameInput, sequence: inputSequence }, buildKccEntrySignatureScript({ entry: action, args, redeemScript: gameInput.redeemScript }));
  const ordinaryInputs = feeInputs.map((entry) => normalizeInput(entry, ''));
  const totalIn = [input, ...ordinaryInputs].reduce((sum, entry) => sum + BigInt(entry.utxo.amount), 0n);
  const payout = positiveAmount(payoutValue, 'payout value');
  const primaryOutput = { value: String(payout), scriptPublicKey: recipientScriptPublicKey, covenant: null };
  const outputs = [...(omitPrimaryOutput ? [] : [primaryOutput]), ...normalizeExtraOutputs(extraOutputs)];
  const terminalOut = outputs.reduce((sum, output) => sum + BigInt(output.value), 0n);
  const expectedChange = totalIn - terminalOut - feeSompi;
  if (expectedChange < 0n) throw new ProtocolError('INSUFFICIENT_UTXOS', 'Inputs cannot fund the payout and fee');
  if (change !== undefined && BigInt(change.value) !== expectedChange) {
    throw new ProtocolError('FEE_SUBSTITUTION', 'Change does not match the exact fee');
  }
  if (expectedChange > 0n) {
    if (!change?.scriptPublicKey) throw new ProtocolError('INVALID_TRANSACTION', 'Change script public key is required');
    outputs.push({ value: String(expectedChange), scriptPublicKey: change.scriptPublicKey, covenant: null });
  }
  return Object.freeze({
    action,
    feeSompi,
    payoutSompi: payout,
    transaction: {
      id: '00'.repeat(32),
      version: 1,
      inputs: [input, ...ordinaryInputs],
      outputs,
      subnetworkId: '00'.repeat(20),
      lockTime: String(lockTime),
      gas: '0',
      storageMass: '0',
      payload: '',
    },
  });
}

export function prepareCovenantOnlyTransaction({ action, gameInput, inputSequence = 0n, lockTime = 0n, args, outputs }) {
  if (!gameInput || typeof gameInput !== 'object') throw new ProtocolError('INVALID_TRANSACTION', 'Current game UTXO is required');
  if (!Array.isArray(outputs) || outputs.length === 0) throw new ProtocolError('INVALID_TRANSACTION', 'Covenant settlement outputs are required');
  const input = normalizeInput({ ...gameInput, sequence: inputSequence }, buildKccEntrySignatureScript({
    entry: action,
    args,
    redeemScript: gameInput.redeemScript,
  }));
  const normalizedOutputs = normalizeExtraOutputs(outputs);
  const totalIn = BigInt(input.utxo.amount);
  const totalOut = normalizedOutputs.reduce((sum, output) => sum + BigInt(output.value), 0n);
  if (totalOut >= totalIn) throw new ProtocolError('INVALID_TRANSACTION', 'Covenant settlement must reserve a network fee');
  return Object.freeze({
    action,
    feeSompi: totalIn - totalOut,
    payoutSompi: BigInt(normalizedOutputs[0].value),
    transaction: {
       id: '00'.repeat(32), version: 1, inputs: [input], outputs: normalizedOutputs,
       subnetworkId: '00'.repeat(20), lockTime: String(lockTime), gas: '0', storageMass: '0', payload: '',
    },
  });
}

export function validateRevealTemplate({ game, caller, currentDaaScore, secret, transaction }) {
  const decision = resolveReveal({ game, caller, currentDaaScore, secret });
  if (!decision.available) throw new ProtocolError('ACTION_UNAVAILABLE', decision.message);
  if (!verifyRevealPreimage({ commitment: game.commitments?.[caller] ?? game.participants?.[caller]?.commitment, choice: decision.choice, nonceHex: decision.nonceHex })) {
    throw new ProtocolError('INVALID_REVEAL', 'Reveal preimage does not match commitment');
  }
  const tx = parseTransaction(transaction);
  if (!game.firstReveal) {
    assertRevealContinuation(tx, grossPotSompi(game.stakeSompi));
  } else {
    const winner = parityOutcome({
      creatorChoice: caller === 'creator' ? decision.choice : game.creatorChoice,
      joinerChoice: caller === 'joiner' ? decision.choice : game.joinerChoice,
      creatorEven: game.creatorEven,
    });
    assertSinglePayout(tx, winnerPayoutSompi(game.stakeSompi), game.participants?.[winner]?.scriptPublicKey, 'winner payout');
    assertGameFeeOutput(tx, gameFeeSompi(game.stakeSompi));
  }
  assertFeeSeparated(tx);
  return tx;
}

function assertRevealContinuation(transaction, value) {
  const continuations = transaction.outputs.filter((output) => BigInt(output?.value ?? -1) === value && output?.covenant);
  if (continuations.length !== 1) {
    throw new ProtocolError('INVALID_TRANSACTION', 'First reveal must preserve the joined escrow in one covenant continuation output');
  }
}

function assertSinglePayout(transaction, value, scriptPublicKey, name) {
  const payouts = transaction.outputs.filter((output) => BigInt(output?.value ?? -1) === BigInt(value) && output?.scriptPublicKey === scriptPublicKey);
  if (payouts.length !== 1) {
    throw new ProtocolError('INVALID_TRANSACTION', `Transaction must contain exactly one ${name}`);
  }
}

function assertGameFeeOutput(transaction, value) {
  if (value === 0n) return;
  const fees = transaction.outputs.filter((output) => BigInt(output?.value ?? -1) === BigInt(value) && !output?.covenant);
  if (fees.length !== 1) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Transaction must contain exactly one game fee output');
  }
}

function assertFeeSeparated(transaction) {
  const totalIn = transaction.inputs.reduce((sum, input) => sum + BigInt(input?.utxo?.amount ?? -1), 0n);
  const totalOut = transaction.outputs.reduce((sum, output) => sum + BigInt(output?.value ?? -1), 0n);
  if (totalIn < totalOut) throw new ProtocolError('FEE_SUBSTITUTION', 'Payout value cannot fund fees');
}

function parseTransaction(transaction) {
  const parsed = typeof transaction === 'string' ? JSON.parse(transaction) : transaction;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.inputs) || !Array.isArray(parsed.outputs)) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Transaction template must include inputs and outputs');
  }
  return parsed;
}

function normalizeExtraOutputs(outputs) {
  if (!Array.isArray(outputs)) throw new ProtocolError('INVALID_TRANSACTION', 'Extra outputs must be an array');
  return outputs.map((output) => {
    if (typeof output?.scriptPublicKey !== 'string' || output.scriptPublicKey.length === 0) {
      throw new ProtocolError('INVALID_TRANSACTION', 'Extra output script public key is required');
    }
    return {
      value: String(positiveAmount(output.value, 'extra output value')),
      scriptPublicKey: output.scriptPublicKey,
      covenant: output.covenant ?? null,
    };
  });
}

export function serializeTerminalTransaction(prepared, wasm = loadWasmSdk()) {
  if (!prepared?.transaction) throw new ProtocolError('INVALID_TRANSACTION', 'Prepared terminal transaction is required');
  try {
    const transaction = wasm.Transaction.deserializeFromSafeJSON(JSON.stringify(prepared.transaction));
    transaction.finalize();
    return transaction.serializeToSafeJSON();
  } catch (error) {
    throw new ProtocolError('INVALID_TRANSACTION', `WASM rejected terminal transaction: ${error?.message ?? error}`);
  }
}

export function verifySignedTerminalTransaction({ prepared, signedTxJson }) {
  if (!prepared?.transaction || typeof signedTxJson !== 'string') {
    throw new ProtocolError('INVALID_TRANSACTION', 'Prepared and signed terminal transactions are required');
  }
  const preparedTxJson = serializeTerminalTransaction(prepared);
  verifyWasmSignedSafeJson({
    preparedTxJson,
    signedTxJson,
    policy: {},
  });
  const expected = JSON.parse(preparedTxJson);
  const signed = JSON.parse(signedTxJson);
  if (signed.inputs[0]?.signatureScript !== expected.inputs[0]?.signatureScript) {
    throw new ProtocolError('SIGNED_TRANSACTION_MISMATCH', `Wallet changed the covenant invocation (${describeTransactionChanges(expected, signed)})`);
  }
  const unsigned = unsignedInputs(signed.inputs, 1);
  if (unsigned.length > 0) {
    throw new ProtocolError('SIGNING_FAILED', `Wallet did not sign every player funding input (unsigned ${unsigned.join(',')})`);
  }
  return signedTxJson;
}

function addArgument(builder, argument) {
  if (argument?.type === 'int') {
    if (typeof argument.value !== 'bigint' && !Number.isSafeInteger(argument.value)) throw new ProtocolError('INVALID_TRANSACTION', 'KCC integer argument must be a safe integer');
    builder.addI64(BigInt(argument.value));
    return;
  }
  const value = argument?.value ?? argument;
  const bytes = value instanceof Uint8Array || ArrayBuffer.isView(value) ? value : hexBytes(value);
  if (bytes.length === 0) throw new ProtocolError('INVALID_TRANSACTION', 'KCC byte argument cannot be empty');
  builder.addData(bytes);
}

function normalizeInput(entry, signatureScript) {
  const txid = entry.transactionId ?? entry.outpoint?.transactionId;
  const index = entry.index ?? entry.outpoint?.index;
  if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid) || !Number.isInteger(index) || index < 0) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Terminal input outpoint is invalid');
  }
  if (typeof entry.scriptPublicKey !== 'string' || entry.scriptPublicKey.length === 0) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Terminal input script public key is required');
  }
  return {
    transactionId: txid.toLowerCase(),
    index,
    sequence: String(entry.sequence ?? 0),
    sigOpCount: Number(entry.sigOpCount ?? 0),
    computeBudget: Number(entry.computeBudget ?? 50),
    signatureScript,
    utxo: {
      amount: String(positiveAmount(entry.amount ?? entry.utxo?.amount, 'input amount')),
      scriptPublicKey: entry.scriptPublicKey ?? entry.utxo?.scriptPublicKey,
      blockDaaScore: String(entry.blockDaaScore ?? entry.utxo?.blockDaaScore ?? 0),
      isCoinbase: entry.isCoinbase === true || entry.utxo?.isCoinbase === true,
      ...(entry.covenantId || entry.utxo?.covenantId ? { covenantId: entry.covenantId ?? entry.utxo.covenantId } : {}),
    },
  };
}

function positiveAmount(value, name) {
  try {
    const amount = typeof value === 'bigint' ? value : BigInt(value);
    if (amount > 0n) return amount;
  } catch {}
  throw new ProtocolError('INVALID_TRANSACTION', `${name} must be a positive integer`);
}

function hexBytes(value) {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Byte argument must be hexadecimal');
  }
  return hexToBytes(value);
}

function pushScriptData(value) {
  const data = hexBytes(value);
  const length = data.length;
  if (length <= 75) return length.toString(16).padStart(2, '0') + bytesToHex(data);
  if (length <= 0xffff) {
    const size = Uint8Array.of(length & 0xff, (length >> 8) & 0xff);
    return `4d${bytesToHex(size)}${bytesToHex(data)}`;
  }
  throw new ProtocolError('INVALID_TRANSACTION', 'Redeem script is too large');
}

function playerScriptPublicKey(publicKey) {
  if (typeof publicKey !== 'string' || !/^[0-9a-f]{64}$/i.test(publicKey)) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Player public key must be 32-byte hexadecimal');
  }
  return `000020${publicKey.toLowerCase()}ac`;
}
