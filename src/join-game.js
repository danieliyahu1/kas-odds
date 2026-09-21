import { PROTOCOL_VERSION, ProtocolError, stakeToSompi, validateGameId, validateNetwork, MIN_STAKE_SOMPI } from './protocol.js';
import { parseInvite } from './invite.js';

export const JOIN_COPY = Object.freeze({ matched: 'Game matched. Reveal phase is now open.', unavailable: 'This game is no longer accepting a player.', wrongStake: 'Player B must match the exact stake.' });

export function prepareJoinGame({ invite, expectedOrigin, network, joinerAddress, joinerPublicKey, joinerCommitment, stakeSompi, stakeKas, currentDaaScore }) {
  const parsed = typeof invite === 'string' ? parseInvite(invite, expectedOrigin, network) : invite;
  validateNetwork(network);
  if (!parsed || parsed.protocolVersion !== PROTOCOL_VERSION || parsed.network !== network) throw new ProtocolError('INVALID_INVITE', 'Invite does not match the selected network');
  return Object.freeze({ protocolVersion: PROTOCOL_VERSION, network, gameId: validateGameId(parsed.gameId), joinerAddress, joinerPublicKey, joinerCommitment, stakeSompi: stakeSompi === undefined ? stakeToSompi(stakeKas) : normalizeStakeSompi(stakeSompi), currentDaaScore: normalizeAmount(currentDaaScore, 'Current DAA score') });
}

export async function prepareJoin({ request, chain }) {
  assertChain(chain, ['readGameState', 'prepareJoin']);
  const game = await readJoinableGame(chain, request);
  if (BigInt(game.stakeSompi ?? game.potSompi) !== request.stakeSompi) throw new ProtocolError('STAKE_MISMATCH', JOIN_COPY.wrongStake);
  const prepared = await chain.prepareJoin({ request, game });
  if (!prepared || typeof prepared.txJson !== 'string' || typeof prepared.preparedHash !== 'string') throw new ProtocolError('INVALID_TRANSACTION', 'Chain returned no prepared join transaction');
  return Object.freeze({ game, prepared });
}

export async function createAndConfirmJoin({ request, wallet, chain, store }) {
  if (!wallet || typeof wallet.sign !== 'function') throw new ProtocolError('WALLET_UNAVAILABLE', 'Compatible wallet is required');
  assertChain(chain, ['readGameState', 'prepareJoin', 'verifySignedJoin', 'submitJoin', 'confirmJoin']);
  assertStore(store);
  const { game, prepared } = await prepareJoin({ request, chain });
  const operationKey = joinOperationKey({ request, prepared });
  let record = await store.load(operationKey);
  if (record && record.preparedHash !== prepared.preparedHash) throw new ProtocolError('RECOVERY_CONFLICT', 'Stored join does not match the current game state');
  if (!record) record = await save(store, { operationKey, action: 'join', network: request.network, account: request.joinerAddress, gameId: request.gameId, preparedHash: prepared.preparedHash, txJson: prepared.txJson, status: 'prepared' });
  if (!record.transactionId) {
    try {
      const signedTxJson = await wallet.sign({ ...prepared, network: request.network, joinerAddress: request.joinerAddress });
      record = await save(store, { ...record, status: 'partially_signed' });
      await chain.verifySignedJoin({ request, game, prepared, signedTxJson });
      const transactionId = normalizeTxId(await chain.submitJoin({ request, game, prepared, signedTxJson }));
      record = await save(store, { ...record, transactionId, status: 'broadcast', lastError: undefined });
    } catch (error) {
      await save(store, { ...record, status: error?.code === 'WALLET_REJECTED' || error?.code === 4001 ? 'rejected' : record.status, lastError: publicError(error) });
      throw error;
    }
  }
  return confirmJoin({ request, game, prepared, record, chain, store });
}

export async function recoverJoin({ operationKey, request, chain, store }) {
  assertChain(chain, ['readGameState', 'prepareJoin', 'confirmJoin']);
  assertStore(store);
  const record = await store.load(operationKey);
  if (!record) throw new ProtocolError('GAME_NOT_FOUND', 'No saved join operation was found');
  if (!record.transactionId) return Object.freeze({ status: record.status, transactionId: null, message: 'Transaction is pending confirmation.' });
  const { game, prepared } = await prepareJoin({ request, chain });
  if (prepared.preparedHash !== record.preparedHash) throw new ProtocolError('RECOVERY_CONFLICT', 'Recovered join no longer matches confirmed chain state');
  return confirmJoin({ request, game, prepared, record, chain, store });
}

async function confirmJoin({ request, game, prepared, record, chain, store }) {
  const confirmation = await chain.confirmJoin({ request, game, prepared, transactionId: record.transactionId });
  if (confirmation?.status !== 'confirmed') {
    const saved = await save(store, { ...record, status: ['observed', 'stale', 'reorged', 'rejected'].includes(confirmation?.status) ? confirmation.status : 'observed' });
    return Object.freeze({ status: saved.status, transactionId: saved.transactionId, message: 'Transaction is pending confirmation.' });
  }
  const saved = await save(store, { ...record, status: 'confirmed', confirmedDaaScore: String(confirmation.confirmedDaaScore ?? '') });
  return Object.freeze({ status: saved.status, transactionId: saved.transactionId, gameId: request.gameId, joinerSide: game.creatorEven ? 'odd' : 'even', message: JOIN_COPY.matched });
}

export function joinOperationKey({ request, prepared }) { if (!request?.gameId || !request?.joinerAddress || !prepared?.preparedHash) throw new ProtocolError('INVALID_TRANSACTION', 'Join operation identity is incomplete'); return [PROTOCOL_VERSION, 'join', request.network, request.gameId, request.joinerAddress, prepared.preparedHash].join('\u0000'); }

async function readJoinableGame(chain, request) {
  const game = await chain.readGameState({ gameId: request.gameId, network: request.network });
  if (!game || game.network !== request.network || game.confirmationStatus !== 'confirmed' || game.conflicting === true || game.reorged === true || ![0, '0', 'waiting', 'open'].includes(game.status)) throw new ProtocolError('GAME_UNAVAILABLE', JOIN_COPY.unavailable);
  let deadline;
  try { deadline = BigInt(game.deadlineDaa); } catch { throw new ProtocolError('GAME_UNAVAILABLE', JOIN_COPY.unavailable); }
  if (request.currentDaaScore >= deadline) throw new ProtocolError('GAME_UNAVAILABLE', JOIN_COPY.unavailable);
  return game;
}

function normalizeAmount(value, name) { try { const result = typeof value === 'bigint' ? value : BigInt(value); if (result >= 0n) return result; } catch {} throw new ProtocolError('INVALID_GAME_VALUE', `${name} must be a non-negative integer`); }
function normalizeStakeSompi(value) { try { const result = typeof value === 'bigint' ? value : BigInt(value); if (result >= MIN_STAKE_SOMPI) return result; } catch {} throw new ProtocolError('INVALID_STAKE', 'Requested stake must be at least 1 KAS'); }
function normalizeTxId(value) { if (!/^[0-9a-f]{64}$/i.test(value ?? '')) throw new ProtocolError('SUBMISSION_FAILED', 'Join submission did not return a transaction identifier'); return value.toLowerCase(); }
function assertChain(chain, methods) { if (!chain || methods.some((method) => typeof chain[method] !== 'function')) throw new ProtocolError('CHAIN_UNAVAILABLE', 'Complete join chain adapter is required'); }
function assertStore(store) { if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') throw new ProtocolError('STORAGE_UNAVAILABLE', 'Join lifecycle storage is required'); }
async function save(store, record) { const snapshot = { ...record, updatedAt: new Date().toISOString() }; await store.save(snapshot); return snapshot; }
function publicError(error) { return { code: String(error?.code ?? 'UNKNOWN'), message: String(error?.message ?? 'Operation failed') }; }
