import {
  NETWORK,
  PROTOCOL_VERSION,
  ProtocolError,
  stakeToSompi,
  validateFeeSeparation,
  validateGameFeePublicKey,
  validateNetwork,
  validateSide,
  AUTOMATION_FEE_SOMPI,
} from './protocol.js';
import { serializeInvite } from './invite.js';
import { deriveGameInstance, EVEN_ODD_TEMPLATE } from './covenant/even-odd.mjs';
import { blake2b256 } from './hashes/blake2b.mjs';
import { bytesToHex, hexToBytes } from './hashes/hex.mjs';
import { validateCreationTransaction, verifySignedCreationSafeJson } from './genesis-transaction.js';

const ACTION = 'create';
const CONFIRMATION_STATES = new Set(['observed', 'stale', 'reorged', 'rejected']);

export function prepareCreateGame({
  network,
  creatorAddress,
  creatorPublicKey,
  creatorCommitment,
  deadlineDaa,
  side,
  stakeKas,
  feeSompi,
  gameFeePublicKey,
}) {
  validateNetwork(network);
  validateSide(side);
  const stakeSompi = stakeToSompi(stakeKas);
  validateFeeSeparation({ gameValue: stakeSompi, feeValue: feeSompi });
  const publicKey = normalizePublicKey(creatorPublicKey, 'creator public key');
  const commitment = normalizeHex(creatorCommitment, 32, 'creator commitment');
  const deadline = normalizePositiveBigInt(deadlineDaa, 'deadline DAA score');
  const feePublicKey = normalizePublicKey(validateGameFeePublicKey(gameFeePublicKey), 'game fee public key');
  const gameWalletHash = bytesToHex(blake2b256(hexToBytes(feePublicKey))).toLowerCase();
    const covenant = deriveGameInstance({
    creatorPubkey: publicKey,
    creatorCommit: commitment,
    stakeSompi,
     deadlineDaa: deadline,
     creatorEven: side === 'even',
    gameWalletHash,
    settleFee: AUTOMATION_FEE_SOMPI,
  });
  return Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    network: NETWORK,
    creatorAddress,
    side,
    creatorEven: side === 'even',
    stakeSompi,
    feeSompi,
    gameFeePublicKey: feePublicKey,
    gameWalletHash,
    settleFeeSompi: AUTOMATION_FEE_SOMPI,
    creatorPublicKey: publicKey,
    creatorCommitment: commitment,
    deadlineDaa: deadline,
    covenantTemplateHash: EVEN_ODD_TEMPLATE.templateHash,
    covenantAddress: covenant.address,
    covenantScriptPublicKey: covenant.p2shScript.toString('hex'),
    covenantRedeemScript: covenant.redeemScript.toString('hex'),
  });
}

export function normalizePublicKey(value, name = 'public key') {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value)) {
    throw new ProtocolError('INVALID_GAME_STATE', `${name} must be a hexadecimal x-only public key`);
  }
  const normalized = value.toLowerCase();
  if (normalized.length === 64) return normalized;
  if (normalized.length === 66 && /^(02|03)/.test(normalized)) return normalized.slice(2);
  throw new ProtocolError('INVALID_GAME_STATE', `${name} must be a 32-byte x-only or compressed public key`);
}

export async function createAndConfirmGame({ request, wallet, chain, inviteOrigin, store }) {
  if (!wallet || typeof wallet.sign !== 'function') {
    throw new ProtocolError('WALLET_UNAVAILABLE', 'Compatible wallet is required');
  }
  const methods = ['prepareCreation', 'verifySignedCreation', 'submitCreation', 'confirmCreation'];
  if (!chain || methods.some((method) => typeof chain[method] !== 'function')) {
    throw new ProtocolError('CHAIN_UNAVAILABLE', 'Complete chain transaction adapter is required');
  }
  assertStore(store);
  const prepared = validatePreparedCreation(await chain.prepareCreation(request), request);
  const operationKey = createOperationKey(prepared);
  let record = await store.load(operationKey);

  if (record && !samePreparedOperation(record, prepared)) {
    throw new ProtocolError('RECOVERY_CONFLICT', 'Stored creation does not match the prepared transaction');
  }
  if (!record) {
    record = await save(store, {
      operationKey,
      action: ACTION,
      network: prepared.network,
      account: prepared.creatorAddress,
      preparedHash: prepared.preparedHash,
      preparedTxJson: prepared.txJson,
      policy: prepared.policy,
      status: 'prepared',
    });
  }

  if (!record.transactionId) {
    try {
      const signedTxJson = await wallet.sign(prepared);
      record = await save(store, { ...record, status: 'partially_signed' });
      verifySignedCreationSafeJson({
        preparedTxJson: prepared.txJson,
        signedTxJson,
        request,
        policy: prepared.policy,
      });
      const signedTransaction = await chain.verifySignedCreation({ request, prepared, signedTxJson });
      const transactionId = normalizeTransactionId(await chain.submitCreation(signedTransaction));
      record = await save(store, { ...record, transactionId, status: 'broadcast', lastError: undefined });
    } catch (error) {
      const status = isWalletRejection(error) ? 'rejected' : record.status;
      await save(store, { ...record, status, lastError: publicError(error) });
      throw error;
    }
  }

  return confirmAndPresent({ record, request, prepared, chain, store, inviteOrigin });
}

export async function recoverCreateGame({ operationKey, request, chain, store, inviteOrigin }) {
  assertStore(store);
  const record = await store.load(operationKey);
  if (!record) throw new ProtocolError('GAME_NOT_FOUND', 'No saved creation operation was found');
  if (!record.transactionId) {
    return Object.freeze({ status: record.status, transactionId: null, gameId: null, inviteUrl: null });
  }
  const prepared = validatePreparedCreation({
    network: record.network,
    creatorAddress: record.account,
      preparedHash: record.preparedHash,
      txJson: record.preparedTxJson,
      policy: record.policy,
  }, request);
  return confirmAndPresent({ record, request, prepared, chain, store, inviteOrigin });
}

export function createOperationKey({ network, creatorAddress, preparedHash }) {
  for (const [field, value] of Object.entries({ network, creatorAddress, preparedHash })) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000')) {
      throw new ProtocolError('INVALID_TRANSACTION', `Prepared ${field} is required`);
    }
  }
  return [network, ACTION, creatorAddress, preparedHash].join('\u0000');
}

export class MemoryGameStore {
  constructor(records = []) {
    this.records = new Map(records.map((record) => [record.operationKey, structuredClone(record)]));
  }

  async load(operationKey) {
    const record = this.records.get(operationKey);
    return record ? structuredClone(record) : null;
  }

  async save(record) {
    this.records.set(record.operationKey, structuredClone(record));
  }
}

async function confirmAndPresent({ record, request, prepared, chain, store, inviteOrigin }) {
  let confirmation;
  try {
    confirmation = await chain.confirmCreation({ transactionId: record.transactionId, request, prepared });
  } catch (error) {
    await save(store, { ...record, lastError: publicError(error) });
    throw error;
  }
  const status = confirmation?.status;
  if (status !== 'confirmed') {
    const safeStatus = CONFIRMATION_STATES.has(status) ? status : record.status;
    await save(store, { ...record, status: safeStatus, lastError: undefined });
    throw new ProtocolError(status === 'reorged' ? 'CREATION_REORGED' : 'NOT_CONFIRMED',
      status === 'reorged' ? 'Creation confirmation was removed from the selected chain' : 'Creation transaction was not authoritatively confirmed');
  }
  const confirmed = await save(store, {
    ...record,
    status: 'confirmed',
    acceptingBlockHash: confirmation.acceptingBlockHash,
    acceptingDaaScore: asOptionalString(confirmation.acceptingDaaScore),
    confirmedDaaScore: asOptionalString(confirmation.confirmedDaaScore),
    lastError: undefined,
  });
  return Object.freeze({
    status: confirmed.status,
    message: 'Game created. Waiting for Player B.',
    transactionId: confirmed.transactionId,
    gameId: confirmed.transactionId,
    inviteUrl: serializeInvite({ gameId: confirmed.transactionId, origin: inviteOrigin }),
  });
}

function validatePreparedCreation(prepared, request) {
  if (!prepared || typeof prepared !== 'object'
    || typeof prepared.txJson !== 'string' || prepared.txJson.length === 0
    || typeof prepared.preparedHash !== 'string' || !/^[0-9a-f]{64}$/i.test(prepared.preparedHash)) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Prepared SafeJSON and template hash are required');
  }
  if (prepared.network !== request?.network || prepared.creatorAddress !== request?.creatorAddress) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Prepared transaction does not match the creation request');
  }
  validateCreationTransaction(prepared.txJson, request, prepared.policy);
  return prepared;
}

function normalizeTransactionId(transactionId) {
  if (!/^[0-9a-f]{64}$/i.test(transactionId ?? '')) {
    throw new ProtocolError('SUBMISSION_FAILED', 'Chain submission did not return a transaction identifier');
  }
  return transactionId.toLowerCase();
}

function samePreparedOperation(record, prepared) {
  return record.action === ACTION
    && record.network === prepared.network
    && record.account === prepared.creatorAddress
    && record.preparedHash === prepared.preparedHash
    && record.preparedTxJson === prepared.txJson
    && JSON.stringify(record.policy) === JSON.stringify(prepared.policy);
}

function assertStore(store) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    throw new ProtocolError('STORAGE_UNAVAILABLE', 'Creation lifecycle storage is required');
  }
}

async function save(store, record) {
  const snapshot = { ...record, updatedAt: new Date().toISOString() };
  await store.save(snapshot);
  return snapshot;
}

function isWalletRejection(error) {
  return error?.code === 'WALLET_REJECTED' || error?.code === 4001;
}

function publicError(error) {
  return { code: String(error?.code ?? 'UNKNOWN'), message: String(error?.message ?? 'Operation failed') };
}

function asOptionalString(value) {
  return value === undefined || value === null ? undefined : String(value);
}

function normalizeHex(value, bytes, name) {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/i.test(value)) {
    throw new ProtocolError('INVALID_GAME_STATE', `${name} must be ${bytes} bytes of hexadecimal`);
  }
  return value.toLowerCase();
}

function normalizePositiveBigInt(value, name) {
  if (typeof value !== 'bigint' || value <= 0n || value > 0x7fffffffffffffffn) {
    throw new ProtocolError('INVALID_GAME_STATE', `${name} must be a positive signed 64-bit bigint`);
  }
  return value;
}
