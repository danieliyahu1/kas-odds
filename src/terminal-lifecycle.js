import { ProtocolError, PROTOCOL_VERSION } from './protocol.js';
import { TERMINAL_COPY } from './terminal-actions.js';
import {
  prepareRevealTransaction,
  serializeTerminalTransaction,
  verifySignedTerminalTransaction,
} from './terminal-transactions.js';

const ACTIONS = Object.freeze({ reveal: prepareRevealTransaction });
const TERMINAL_STATES = new Set(['prepared', 'partially_signed', 'broadcast', 'observed', 'confirmed', 'rejected', 'stale', 'reorged']);

export class MemoryTerminalStore {
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

export async function prepareTerminalAction({ action, chain, request }) {
  if (!ACTIONS[action]) throw new ProtocolError('UNSUPPORTED_ACTION', `Unsupported terminal action ${action}`);
  if (!chain || typeof chain.prepareTerminalAction !== 'function') {
    throw new ProtocolError('CHAIN_UNAVAILABLE', 'Terminal chain preparation is required');
  }
  const authoritative = await readAuthoritativeState(chain, request);
  const prepared = await chain.prepareTerminalAction({ action, request, game: authoritative });
  if (!prepared || typeof prepared !== 'object' || typeof prepared.txJson !== 'string') {
    throw new ProtocolError('INVALID_TRANSACTION', 'Chain returned no prepared terminal transaction');
  }
  return Object.freeze({ action, game: authoritative, prepared });
}

export async function createAndConfirmTerminalAction({ action, request, wallet, chain, store }) {
  if (!wallet || typeof wallet.sign !== 'function') throw new ProtocolError('WALLET_UNAVAILABLE', 'Compatible wallet is required');
  assertChain(chain);
  assertStore(store);
  const { game, prepared } = await prepareTerminalAction({ action, chain, request });
  const operationKey = terminalOperationKey({ action, request, prepared });
  let record = await store.load(operationKey);
  if (record && record.preparedHash !== prepared.preparedHash) throw new ProtocolError('RECOVERY_CONFLICT', 'Stored terminal transaction does not match the current chain state');
  if (!record) record = await save(store, { operationKey, action, account: request.caller, preparedHash: prepared.preparedHash, txJson: prepared.txJson, status: 'prepared' });

  if (!record.transactionId) {
    try {
      const signedTxJson = await wallet.sign({ action, txJson: prepared.txJson, preparedHash: prepared.preparedHash, game });
      record = await save(store, { ...record, status: 'partially_signed' });
      verifySignedTerminalTransaction({ prepared: { transaction: JSON.parse(prepared.txJson) }, signedTxJson });
      const transactionId = await chain.submitTerminal({ action, request, game, prepared, signedTxJson });
      if (!/^[0-9a-f]{64}$/i.test(transactionId ?? '')) throw new ProtocolError('SUBMISSION_FAILED', 'Terminal submission did not return a transaction identifier');
      record = await save(store, { ...record, transactionId: transactionId.toLowerCase(), status: 'broadcast' });
    } catch (error) {
      await save(store, { ...record, status: error?.code === 'WALLET_REJECTED' || error?.code === 4001 ? 'rejected' : record.status, lastError: publicError(error) });
      throw error;
    }
  }
  return confirmTerminalAction({ action, request, game, prepared, record, chain, store });
}

export async function recoverTerminalAction({ operationKey, action, request, chain, store }) {
  assertChain(chain);
  assertStore(store);
  const record = await store.load(operationKey);
  if (!record) throw new ProtocolError('GAME_NOT_FOUND', 'No saved terminal operation was found');
  if (!record.transactionId) return Object.freeze({ status: record.status, transactionId: null, message: TERMINAL_COPY.transactionPending });
  const { game, prepared } = await prepareTerminalAction({ action, chain, request });
  if (prepared.preparedHash !== record.preparedHash) throw new ProtocolError('RECOVERY_CONFLICT', 'Recovered terminal transaction no longer matches confirmed chain state');
  return confirmTerminalAction({ action, request, game, prepared, record, chain, store });
}

export function terminalOperationKey({ action, request, prepared }) {
  if (!action || !request?.caller || !prepared?.preparedHash) throw new ProtocolError('INVALID_TRANSACTION', 'Terminal operation identity is incomplete');
  return [PROTOCOL_VERSION, action, request.caller, prepared.preparedHash].join('\u0000');
}

export function terminalStatusMessage(action, status) {
  if (status === 'confirmed') {
    if (action === 'fallback_claim') return TERMINAL_COPY.fallbackConfirmed;
    if (action === 'reveal') return 'Reveal confirmed.';
    return TERMINAL_COPY.refundConfirmed;
  }
  if (status === 'rejected') return 'Transaction was rejected.';
  if (status === 'reorged' || status === 'stale') return 'This transaction is no longer valid. Refresh the game.';
  return TERMINAL_COPY.transactionPending;
}

async function confirmTerminalAction({ action, request, game, prepared, record, chain, store }) {
  const confirmation = await chain.confirmTerminal({ action, request, game, prepared, transactionId: record.transactionId });
  if (confirmation?.status !== 'confirmed') {
    const status = TERMINAL_STATES.has(confirmation?.status) ? confirmation.status : 'observed';
    const saved = await save(store, { ...record, status });
    return Object.freeze({ status: saved.status, transactionId: saved.transactionId, message: terminalStatusMessage(action, saved.status) });
  }
  const saved = await save(store, { ...record, status: 'confirmed', confirmedDaaScore: String(confirmation.confirmedDaaScore ?? ''), acceptingDaaScore: String(confirmation.acceptingDaaScore ?? '') });
  return Object.freeze({ status: saved.status, transactionId: saved.transactionId, message: terminalStatusMessage(action, saved.status) });
}

async function readAuthoritativeState(chain, request) {
  if (typeof chain.readGameState !== 'function') throw new ProtocolError('CHAIN_UNAVAILABLE', 'Authoritative game-state reader is required');
  const game = await chain.readGameState({ gameId: request?.gameId, network: request?.network });
  if (!game || game.network !== request?.network || game.confirmationStatus !== 'confirmed') {
    throw new ProtocolError('STATE_UNKNOWN', TERMINAL_COPY.stateUnknown);
  }
  if (game.conflicting === true || game.reorged === true) throw new ProtocolError('STATE_CONFLICTING', TERMINAL_COPY.stateConflicting);
  return game;
}

function assertChain(chain) {
  for (const method of ['readGameState', 'prepareTerminalAction', 'submitTerminal', 'confirmTerminal']) {
    if (typeof chain?.[method] !== 'function') throw new ProtocolError('CHAIN_UNAVAILABLE', 'Complete terminal chain adapter is required');
  }
}

function assertStore(store) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') throw new ProtocolError('STORAGE_UNAVAILABLE', 'Terminal lifecycle storage is required');
}

async function save(store, record) {
  const snapshot = { ...record, updatedAt: new Date().toISOString() };
  await store.save(snapshot);
  return snapshot;
}

function publicError(error) {
  return { code: String(error?.code ?? 'UNKNOWN'), message: String(error?.message ?? 'Operation failed') };
}
