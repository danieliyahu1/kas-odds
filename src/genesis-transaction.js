import { blake2b256 } from './hashes/blake2b.mjs';
import { hexToBytes, bytesToHex } from './hashes/hex.mjs';
import { covenantValueSompi, ProtocolError } from './protocol.js';
import { describeTransactionChanges } from './transaction-diagnostics.js';

const COVENANT_ID_DOMAIN = new TextEncoder().encode('CovenantID');
const TRANSACTION_VERSION = 1;
const GAME_OUTPUT_INDEX = 0;
const SCRIPT_VERSION_HEX = '0000';

export function computeGenesisCovenantId(authorizingOutpoint, outputs) {
  const outpoint = normalizeOutpoint(authorizingOutpoint);
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new ProtocolError('INVALID_COVENANT_BINDING', 'At least one authorized output is required');
  }

  const chunks = [
    hexBytes(outpoint.transactionId, 32, 'authorizing transaction ID'),
    u32le(outpoint.index),
    u64le(BigInt(outputs.length)),
  ];
  let previousIndex = -1;
  for (const entry of outputs) {
    if (!entry || !Number.isInteger(entry.index) || entry.index <= previousIndex) {
      throw new ProtocolError('INVALID_COVENANT_BINDING', 'Authorized output indices must be strictly increasing');
    }
    previousIndex = entry.index;
    const output = entry.output;
    const script = parseScriptPublicKey(output?.scriptPublicKey);
    chunks.push(
      u32le(entry.index),
      u64le(decimalBigInt(output?.value, 'output value')),
      u16le(script.version),
      u64le(BigInt(script.script.length)),
      script.script,
    );
  }
  return bytesToHex(blake2b256(concat(chunks), COVENANT_ID_DOMAIN));
}

export function createGenesisGameOutput({ request, authorizingInput, authorizingOutpoint }) {
  if (!Number.isInteger(authorizingInput) || authorizingInput < 0 || authorizingInput > 0xffff) {
    throw new ProtocolError('INVALID_COVENANT_BINDING', 'Genesis authorizing input must be a u16 index');
  }
  const output = {
    value: covenantValueSompi(request).toString(),
    scriptPublicKey: SCRIPT_VERSION_HEX + request.covenantScriptPublicKey,
    covenant: null,
  };
  const covenantId = computeGenesisCovenantId(authorizingOutpoint, [{ index: GAME_OUTPUT_INDEX, output }]);
  return Object.freeze({
    ...output,
    covenant: Object.freeze({ authorizingInput, covenantId }),
  });
}

export function validateCreationTransaction(txJson, request, policy) {
  const transaction = parseSafeJson(txJson);
  validateSafeJsonEnvelope(transaction);
  if (transaction.version !== TRANSACTION_VERSION) {
    throw invalid('Creation transaction version must be 1');
  }
  if (!Array.isArray(transaction.inputs) || transaction.inputs.length === 0) {
    throw invalid('Creation transaction requires wallet inputs');
  }
  if (!Array.isArray(transaction.outputs) || transaction.outputs.length < 1 || transaction.outputs.length > 2) {
    throw invalid('Creation transaction requires output zero and at most one change output');
  }
  const authorizingInput = policy?.authorizingInput;
  if (!Number.isInteger(authorizingInput) || !transaction.inputs[authorizingInput]) {
    throw invalid('Genesis authorizing input does not exist');
  }

  const expectedGameOutput = createGenesisGameOutput({
    request,
    authorizingInput,
    authorizingOutpoint: transaction.inputs[authorizingInput],
  });
  assertOutput(transaction.outputs[GAME_OUTPUT_INDEX], expectedGameOutput, 'game output');

  for (const input of transaction.inputs) {
    decimalBigInt(input?.utxo?.amount, 'input UTXO amount');
    if (input.utxo.covenantId !== undefined && input.utxo.covenantId !== null) {
      throw invalid('Creation fees must use ordinary non-covenant wallet inputs');
    }
    normalizeOutpoint(input);
    if (input.computeBudget === undefined || !Number.isInteger(input.computeBudget) || input.computeBudget < 0 || input.computeBudget > 0xffff) {
      throw invalid('Transaction-v1 inputs require a u16 computeBudget');
    }
  }

  if (transaction.outputs.length === 2) {
    const change = transaction.outputs[1];
    if (!policy?.changeScriptPublicKey || change.scriptPublicKey !== policy.changeScriptPublicKey) {
      throw invalid('Change output script is not the approved creator change script');
    }
    if (change.covenant !== undefined && change.covenant !== null) {
      throw invalid('Wallet change must not carry a covenant binding');
    }
    if (decimalBigInt(change.value, 'change value') <= 0n) {
      throw invalid('Change output value must be positive');
    }
  }

  const totalIn = transaction.inputs.reduce((sum, input) => sum + decimalBigInt(input.utxo.amount, 'input UTXO amount'), 0n);
  const totalOut = transaction.outputs.reduce((sum, output) => sum + decimalBigInt(output.value, 'output value'), 0n);
  const expectedFee = policy?.effectiveFeeSompi ?? request.feeSompi;
  if (totalIn < totalOut || totalIn - totalOut !== expectedFee) {
    throw new ProtocolError('FEE_SUBSTITUTION', 'Wallet inputs must fund the exact prepared fee without reducing the game output');
  }
  return transaction;
}

export function verifySignedCreationSafeJson({ preparedTxJson, signedTxJson, request, policy }) {
  const prepared = validateCreationTransaction(preparedTxJson, request, policy);
  const signed = validateCreationTransaction(signedTxJson, request, policy);
  if (stableJson(withoutSignatures(prepared)) !== stableJson(withoutSignatures(signed))) {
    throw new ProtocolError('SIGNED_TRANSACTION_MISMATCH', `Wallet changed fields outside input signature scripts (${describeTransactionChanges(prepared, signed)})`);
  }
  if (!signed.inputs.some((input) => typeof input.signatureScript === 'string' && input.signatureScript.length > 0)) {
    throw new ProtocolError('SIGNING_FAILED', 'Wallet returned no input signatures');
  }
  return signed;
}

function validateSafeJsonEnvelope(transaction) {
  if (transaction.id !== undefined) hexBytes(transaction.id, 32, 'transaction ID');
  hexBytes(transaction.subnetworkId, 20, 'subnetwork ID');
  decimalBigInt(transaction.lockTime, 'lock time');
  decimalBigInt(transaction.gas, 'gas');
  decimalBigInt(transaction.storageMass, 'storage mass');
  if (typeof transaction.payload !== 'string' || transaction.payload.length % 2 !== 0
    || !/^[0-9a-f]*$/i.test(transaction.payload)) {
    throw invalid('payload must be hexadecimal');
  }
  for (const input of transaction.inputs ?? []) {
    decimalBigInt(input.sequence, 'input sequence');
    if (!Number.isInteger(input.sigOpCount) || input.sigOpCount < 0 || input.sigOpCount > 0xff) {
      throw invalid('sigOpCount must be a u8');
    }
    if (typeof input.signatureScript !== 'string' || input.signatureScript.length % 2 !== 0
      || !/^[0-9a-f]*$/i.test(input.signatureScript)) {
      throw invalid('signatureScript must be hexadecimal');
    }
    parseScriptPublicKey(input.utxo?.scriptPublicKey);
    decimalBigInt(input.utxo?.blockDaaScore, 'input block DAA score');
    if (typeof input.utxo?.isCoinbase !== 'boolean') throw invalid('input UTXO isCoinbase must be boolean');
  }
  for (const output of transaction.outputs ?? []) parseScriptPublicKey(output?.scriptPublicKey);
}

function parseScriptPublicKey(value) {
  const bytes = hexBytes(value, undefined, 'scriptPublicKey');
  if (bytes.length < 2) throw invalid('scriptPublicKey must include its u16 version');
  return { version: (bytes[0] << 8) | bytes[1], script: bytes.slice(2) };
}

function assertOutput(actual, expected, name) {
  if (!actual || actual.value !== expected.value || actual.scriptPublicKey !== expected.scriptPublicKey
    || actual.covenant?.authorizingInput !== expected.covenant.authorizingInput
    || String(actual.covenant?.covenantId).toLowerCase() !== expected.covenant.covenantId) {
    throw invalid(`Prepared ${name} does not match the exact stake, P2SH script, and genesis binding`);
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

function parseSafeJson(value) {
  if (typeof value !== 'string' || value.length === 0) throw invalid('SafeJSON is required');
  try {
    const transaction = JSON.parse(value);
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) throw new Error();
    return transaction;
  } catch {
    throw invalid('SafeJSON must contain one transaction object');
  }
}

function normalizeOutpoint(value) {
  const transactionId = value?.transactionId ?? value?.previousOutpoint?.transactionId;
  const index = value?.index ?? value?.previousOutpoint?.index;
  hexBytes(transactionId, 32, 'transaction ID');
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) throw invalid('Outpoint index must be a u32');
  return { transactionId: transactionId.toLowerCase(), index };
}

function decimalBigInt(value, name) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw invalid(`${name} must be a canonical decimal string`);
  }
  const integer = BigInt(value);
  if (integer > 0xffffffffffffffffn) throw invalid(`${name} exceeds u64`);
  return integer;
}

function hexBytes(value, length, name) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(value)) throw invalid(`${name} must be hexadecimal`);
  const bytes = hexToBytes(value);
  if (length !== undefined && bytes.length !== length) throw invalid(`${name} must be ${length} bytes`);
  return bytes;
}

function u16le(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
}

function u32le(value) {
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function u64le(value) {
  if (value < 0n || value > 0xffffffffffffffffn) throw invalid('Value exceeds u64');
  const out = new Uint8Array(8);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function concat(parts) {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function invalid(message) {
  return new ProtocolError('INVALID_TRANSACTION', message);
}
