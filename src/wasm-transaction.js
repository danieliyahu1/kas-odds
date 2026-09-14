import { blake2b256 } from './hashes/blake2b.mjs';
import { bytesToHex } from './hashes/hex.mjs';
import { playerLockSompi, ProtocolError } from './protocol.js';
import { DEFAULT_RELAY_FLOOR_RATE } from './fee-policy.js';
import { loadWasmSdk } from './wasm-loader.mjs';
import { describeTransactionChanges } from './transaction-diagnostics.js';
import { estimateSignedTransactionMass } from './transaction-mass.js';

export { loadWasmSdk };

// Transaction-v1 funding inputs must commit a compute budget large enough to
// cover the schnorr signature (~100,000 script units). Each budget unit grants
// 10,000 script units, so >= 10 is required; Kticket uses 50 for headroom.
export const COMPUTE_BUDGET = 50;
// Standard Kaspa output script_public_key is versioned: u16 version (0x0000)
// followed by the versionless aa20<blake2b256(redeemScript)>87 P2SH script.
const SCRIPT_VERSION_HEX = '0000';

export function createWasmGenesisSafeJson({ request, authorizingInput, inputs, change, feerate, relayFloorRate }) {
  const wasm = loadWasmSdk();
  if (!wasm.Transaction || !wasm.GenesisCovenantGroup) {
    throw new ProtocolError('WASM_UNAVAILABLE', 'WASM Transaction and GenesisCovenantGroup APIs are required');
  }
  const normalizedInputs = normalizeInputs(inputs).map((entry) => ({
    ...entry,
    sigOpCount: 0,
    computeBudget: COMPUTE_BUDGET,
  }));
  const authorizingIndex = normalizeAuthorizingInput(authorizingInput, normalizedInputs);

  const stakeScript = versionCovenantScript(request.covenantScriptPublicKey);
  const changePreference = change ? validateChangeScript(change.scriptPublicKey) : normalizedInputs[0].scriptPublicKey;
  const inputTotal = normalizedInputs.reduce((sum, entry) => sum + entry.amount, 0n);

  // Price the final signed size, including the wallet signatures that are not
  // present until after KasWare receives the prepared transaction.
  const rate = Math.max(Number(feerate ?? 0), Number(relayFloorRate ?? DEFAULT_RELAY_FLOOR_RATE));

  const buildAndFee = (outputs) => {
    const transaction = buildWasmTransaction(wasm, authorizingIndex, normalizedInputs, outputs);
    const transactionJson = JSON.parse(transaction.serializeToSafeJSON());
    const { mass, assumedSignedInputs } = estimateSignedTransactionMass(request.network, transactionJson);
    const fee = BigInt(Math.ceil(mass * rate));
    const changeValue = inputTotal - playerLockSompi(request.stakeSompi) - fee;
    return { transaction, mass, fee, changeValue, assumedSignedInputs };
  };

  const stakeOutput = () => ({ value: String(playerLockSompi(request.stakeSompi)), scriptPublicKey: stakeScript });

  // First determine the fee with just the stake output. If the funding leaves
  // change, add a change output and reprice to a fixed point so the change the
  // tx actually carries equals inputTotal - stake - fee (the fee the node sees
  // via totalIn - totalOut). The SDK mass is amount-sensitive, so iterate until
  // the change value it implies is stable.
  const noChange = buildAndFee([stakeOutput()]);
  if (noChange.changeValue < 0n) {
    throw new ProtocolError('INSUFFICIENT_UTXOS', 'Creator UTXOs cannot fund the game and fee with compute mass');
  }

  let finalTx = noChange.transaction;
  let fee = noChange.fee;
  let mass = noChange.mass;
  let assumedSignedInputs = noChange.assumedSignedInputs;
  let changeValue = noChange.changeValue;
  let withChange = false;
  if (noChange.changeValue > 0n) {
    withChange = true;
    const MAX_ITERATIONS = 8;
    let built = noChange;
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      built = buildAndFee([stakeOutput(), { value: String(changeValue), scriptPublicKey: changePreference }]);
      if (built.changeValue <= 0n) {
        throw new ProtocolError('INSUFFICIENT_UTXOS', 'Creator UTXOs cannot fund the game, fee, and change with compute mass');
      }
      if (built.changeValue === changeValue) break;
      changeValue = built.changeValue;
    }
    finalTx = built.transaction;
    fee = built.fee;
    mass = built.mass;
    assumedSignedInputs = built.assumedSignedInputs;
  }

  // Guarantee consistency: the tx change output must equal inputTotal - lock - fee.
  if (withChange) {
    const expectedChange = inputTotal - playerLockSompi(request.stakeSompi) - fee;
    const actualChange = BigInt(JSON.parse(finalTx.serializeToSafeJSON()).outputs[1].value);
    if (actualChange !== expectedChange) {
      throw new ProtocolError('INVALID_TRANSACTION', 'WASM change output is inconsistent with the charged fee');
    }
  }

  const txJson = finalTx.serializeToSafeJSON();
  const parsed = parseWasmSafeJson(txJson);
  if (parsed.outputs[0]?.covenant?.authorizingInput !== authorizingIndex
    || !parsed.outputs[0]?.covenant?.covenantId) {
    throw new ProtocolError('COVENANT_BINDING_FAILED', 'WASM did not bind output zero to a genesis covenant');
  }
  if (parsed.outputs[0].value !== String(playerLockSompi(request.stakeSompi))
    || parsed.outputs[0].scriptPublicKey !== stakeScript) {
    throw new ProtocolError('INVALID_TRANSACTION', 'WASM output zero does not match the exact lock and versioned P2SH script');
  }

  const policy = { authorizingInput: authorizingIndex };
  if (withChange) policy.changeScriptPublicKey = changePreference;
  const preparedHash = bytesToHex(blake2b256(new TextEncoder().encode(txJson)));
  return Object.freeze({
    txJson,
    preparedHash,
    policy,
    covenantId: parsed.outputs[0].covenant.covenantId,
    feeSompi: fee,
    mass,
    assumedSignedInputs,
    changeValue,
    inputTotal,
  });
}

function buildWasmTransaction(wasm, authorizingIndex, normalizedInputs, outputs) {
  const rawInputs = normalizedInputs.map((entry) => ({
    transactionId: entry.transactionId,
    index: entry.index,
    sequence: String(entry.sequence),
    sigOpCount: entry.sigOpCount,
    computeBudget: entry.computeBudget,
    signatureScript: entry.signatureScript ?? '',
    utxo: {
      amount: String(entry.amount),
      scriptPublicKey: entry.scriptPublicKey,
      blockDaaScore: String(entry.blockDaaScore),
      isCoinbase: entry.isCoinbase,
    },
  }));
  const preparedSafeJson = JSON.stringify({
    id: '00'.repeat(32),
    version: 1,
    inputs: rawInputs,
    outputs,
    lockTime: '0',
    subnetworkId: '00'.repeat(20),
    gas: '0',
    payload: '',
  });
  let transaction;
  try {
    transaction = wasm.Transaction.deserializeFromSafeJSON(preparedSafeJson);
  } catch (error) {
    throw new ProtocolError('INVALID_TRANSACTION', `WASM rejected the prepared transaction: ${error?.message ?? error}`);
  }
  try {
    transaction.populateGenesisCovenants([new wasm.GenesisCovenantGroup(authorizingIndex, [0])]);
  } catch (error) {
    throw new ProtocolError('COVENANT_BINDING_FAILED', `WASM genesis covenant binding failed: ${error?.message ?? error}`);
  }
  transaction.finalize();
  return transaction;
}

function versionCovenantScript(script) {
  if (typeof script !== 'string' || script.length === 0) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Covenant script public key is required');
  }
  return SCRIPT_VERSION_HEX + script;
}

function validateChangeScript(script) {
  if (typeof script !== 'string' || script.length === 0) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Change script public key is required');
  }
  return script;
}

export function verifyWasmSignedSafeJson({ preparedTxJson, signedTxJson, policy }) {
  const wasm = loadWasmSdk();
  const prepared = parseWasmSafeJson(preparedTxJson);
  const signed = parseWasmSafeJson(signedTxJson);
  if (stableJson(withoutSignatures(prepared)) !== stableJson(withoutSignatures(signed))) {
    throw new ProtocolError('SIGNED_TRANSACTION_MISMATCH', `Wallet changed fields outside input signature scripts (${describeTransactionChanges(prepared, signed)})`);
  }
  if (!signed.inputs.some((input) => typeof input.signatureScript === 'string' && input.signatureScript.length > 0)) {
    throw new ProtocolError('SIGNING_FAILED', 'Wallet returned no input signatures');
  }
  return signedTxJson;
}

function normalizeInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new ProtocolError('INVALID_TRANSACTION', 'At least one funding input is required');
  }
  return inputs.map((entry, index) => {
    const txid = entry?.transactionId;
    const outIndex = entry?.index;
    if (typeof txid !== 'string' || !/^[0-9a-f]{64}$/i.test(txid) || !Number.isInteger(outIndex) || outIndex < 0) {
      throw new ProtocolError('INVALID_TRANSACTION', `Input ${index} outpoint is invalid`);
    }
    const amount = toPositiveBigInt(entry?.amount, `Input ${index} amount`);
    if (typeof entry?.scriptPublicKey !== 'string' || entry.scriptPublicKey.length === 0) {
      throw new ProtocolError('INVALID_TRANSACTION', `Input ${index} script public key is required`);
    }
    const sequence = entry?.sequence ?? 0n;
    const sigOpCount = entry?.sigOpCount ?? 0;
    const computeBudget = entry?.computeBudget ?? 0;
    return {
      transactionId: txid.toLowerCase(),
      index: outIndex,
      sequence,
      sigOpCount,
      computeBudget,
      amount,
      scriptPublicKey: entry.scriptPublicKey,
      blockDaaScore: entry?.blockDaaScore ?? 0n,
      isCoinbase: entry?.isCoinbase === true,
    };
  });
}

function normalizeAuthorizingInput(authorizingInput, inputs) {
  if (typeof authorizingInput !== 'number' || !Number.isInteger(authorizingInput)
    || authorizingInput < 0 || authorizingInput >= inputs.length) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Genesis authorizing input does not exist');
  }
  return authorizingInput;
}

function toPositiveBigInt(value, name) {
  if (typeof value === 'bigint') {
    if (value <= 0n) throw new ProtocolError('INVALID_TRANSACTION', `${name} must be positive`);
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) > 0n) return BigInt(value);
  throw new ProtocolError('INVALID_TRANSACTION', `${name} must be a positive integer`);
}

function parseWasmSafeJson(value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new ProtocolError('INVALID_TRANSACTION', 'SafeJSON must contain one transaction object');
  }
}

function withoutSignatures(transaction) {
  const copy = structuredClone(transaction);
  delete copy.id;
  for (const input of copy.inputs) input.signatureScript = '';
  return copy;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
