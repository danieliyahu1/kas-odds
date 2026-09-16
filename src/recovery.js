import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ProtocolError, PROTOCOL_VERSION, validateGameId, validateNetwork } from './protocol.js';

const SECRET_FIELDS = /secret|nonce|preimage|private.?key|signature.?script/i;

/** Classifies an observed transaction without treating an untrusted node result as confirmed. */
export function classifyTransaction(transaction) {
  if (!transaction || typeof transaction !== 'object') return 'unknown';
  if (transaction.conflicting === true || transaction.status === 'conflicting') return 'conflicting';
  if (transaction.supported === false || transaction.unsupported === true) return 'unsupported';
  if (transaction.expired === true || transaction.status === 'expired') return 'expired';
  if (transaction.rejected === true || transaction.status === 'rejected') return 'rejected';
  if (transaction.confirmed === true || transaction.isConfirmed === true
    || Number(transaction.confirmations) >= 1 || transaction.status === 'confirmed') return 'confirmed';
  if (transaction.pending === true || transaction.status === 'pending' || transaction.status === 'observed') return 'pending';
  if (transaction.isAccepted === true || transaction.status === 'accepted' || transaction.status === 'mempool') return 'pending';
  return 'unknown';
}

export function reconstructGameState(history, options = {}) {
  return reduceGameHistory({
    events: history?.events ?? history,
    checkpoint: history?.checkpoint,
    removedBlocks: history?.removedBlocks ?? [],
    confirmationDepth: history?.confirmationDepth ?? options.confirmationDepth ?? 1,
  });
}

/** Replays accepted, one-confirmed events and rebuilds from the last valid checkpoint. */
export function reduceGameHistory({ events = [], checkpoint = null, removedBlocks = [], confirmationDepth = 1 }) {
  if (!Array.isArray(events)) throw new ProtocolError('INVALID_HISTORY', 'Chain history must be an array');
  if (!Number.isInteger(confirmationDepth) || confirmationDepth < 1) {
    throw new ProtocolError('INVALID_HISTORY', 'Confirmation depth must be a positive integer');
  }
  const removed = new Set(removedBlocks.map(String));
  const validEvents = events
    .filter((event) => event && typeof event === 'object')
    .filter((event) => !removed.has(String(event.blockHash)) && !removed.has(String(event.transactionId)))
    .sort((left, right) => number(left.daaScore ?? left.acceptingDaaScore) - number(right.daaScore ?? right.acceptingDaaScore));
  let applied = checkpoint?.appliedTransactions ? new Set(checkpoint.appliedTransactions) : new Set();
  const checkpointInvalid = checkpoint && (removed.has(String(checkpoint.blockHash))
    || removed.has(String(checkpoint.transactionId))
    || [...applied].some((id) => removed.has(String(id))));
  let state = checkpointInvalid ? null : checkpoint?.state ? clone(checkpoint.state) : null;
  if (checkpointInvalid) applied = new Set();
  let pending = [];
  for (const event of validEvents) {
    const id = event.transactionId;
    if (id && applied.has(id)) continue;
    const status = classifyTransaction(event);
    const confirmations = Number(event.confirmations ?? (status === 'confirmed' ? confirmationDepth : 0));
    if (status !== 'confirmed' || confirmations < confirmationDepth) {
      if (status === 'pending') pending.push(id ?? String(event.daaScore));
      continue;
    }
    if (event.state !== undefined) state = clone(event.state);
    applied.add(id ?? `${event.daaScore}:${applied.size}`);
  }
  const latestDaaScore = validEvents.reduce((latest, event) => Math.max(latest, number(event.daaScore ?? event.acceptingDaaScore)), 0);
  return Object.freeze({
    state,
    status: state ? 'confirmed' : pending.length ? 'pending' : 'unknown',
    pendingTransactions: Object.freeze(pending.filter(Boolean)),
    appliedTransactions: Object.freeze([...applied]),
    checkpoint: Object.freeze({ daaScore: String(latestDaaScore), appliedTransactions: [...applied], state: clone(state) }),
    rebuilt: removed.size > 0,
  });
}

export function invalidateCheckpoint(checkpoint, removedBlocks = []) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const removed = new Set(removedBlocks.map(String));
  if (removed.has(String(checkpoint.blockHash)) || removed.has(String(checkpoint.transactionId))) return null;
  return clone(checkpoint);
}

export function projectRecoveryState({ status, state = null, error = null, pendingTransactions = [], rebuilt = false } = {}) {
  const safeStatus = ['loading', 'empty', 'confirmed', 'pending', 'unknown', 'rejected', 'expired', 'conflicting', 'unsupported', 'stale'].includes(status)
    ? status : 'unknown';
  const canAct = safeStatus === 'confirmed' && Boolean(state) && state.conflicting !== true && state.reorged !== true;
  return Object.freeze({
    status: safeStatus,
    state: canAct ? clone(state) : null,
    permittedAction: canAct ? state.permittedAction ?? null : null,
    pendingTransactions: Object.freeze([...pendingTransactions]),
    rebuilt: Boolean(rebuilt),
    error: error ? { code: String(error.code ?? 'RECOVERY_FAILED'), message: String(error.message ?? 'Recovery failed') } : null,
  });
}

export function createRecoveryLogger(logger = console) {
  return Object.freeze({
    transaction: (event) => logger.info?.(redactedEvent(event)),
    error: (event) => logger.warn?.(redactedEvent(event)),
  });
}

export function bindWalletRecovery(wallet, reload) {
  if (!wallet || typeof wallet.subscribe !== 'function' || typeof reload !== 'function') {
    throw new ProtocolError('RECOVERY_UNAVAILABLE', 'Wallet subscription and state reload are required');
  }
  return wallet.subscribe(({ reason }) => reload({ reason }));
}

export async function recoverAndCheckpoint({ chain, store, gameId, network, metadata = {} }) {
  if (!chain || typeof chain.readGameState !== 'function') throw new ProtocolError('CHAIN_UNAVAILABLE', 'Authoritative game-state reader is required');
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') throw new ProtocolError('STORAGE_UNAVAILABLE', 'Recovery storage is required');
  const key = recoveryOperationKey({ gameId, network });
  const previous = await store.load(key);
  const game = await chain.readGameState({ gameId: validateGameId(gameId), network });
  const view = projectRecoveryState({ ...game, status: game?.confirmationStatus ?? game?.status, state: game?.state ?? game });
  const record = {
    key, gameId: validateGameId(gameId), network, protocolVersion: PROTOCOL_VERSION,
    preparedHash: metadata.preparedHash, artifactMetadata: metadata.artifactMetadata,
    checkpoint: game?.checkpoint ?? previous?.checkpoint ?? null, status: view.status,
  };
  await store.save(record);
  return view;
}

export class MemoryRecoveryStore {
  constructor(records = []) { this.records = new Map(records.map((record) => [record.key, sanitizeRecord(record)])); }
  async load(key) { return clone(this.records.get(key) ?? null); }
  async save(record) { this.records.set(record.key, sanitizeRecord(record)); }
}

export class JsonRecoveryStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new ProtocolError('STORAGE_UNAVAILABLE', 'Recovery store path is required');
    this.filePath = filePath;
  }

  async load(key) {
    const records = await this.#read();
    return clone(records[key] ?? null);
  }

  async save(record) {
    if (!record?.key) throw new ProtocolError('STORAGE_UNAVAILABLE', 'Recovery record key is required');
    const records = await this.#read();
    records[record.key] = sanitizeRecord(record);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(records, null, 2));
    await rename(temporary, this.filePath);
  }

  async #read() {
    try { return JSON.parse(await readFile(this.filePath, 'utf8')); } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw new ProtocolError('STORAGE_UNAVAILABLE', `Unable to read recovery store: ${error.message}`);
    }
  }
}

export const FileRecoveryStore = JsonRecoveryStore;

export function recoveryOperationKey({ gameId, network }) {
  validateNetwork(network);
  return [PROTOCOL_VERSION, 'recovery', network, validateGameId(gameId)].join('\u0000');
}

export function sanitizeRecord(record) {
  if (!record || typeof record !== 'object') throw new ProtocolError('STORAGE_UNAVAILABLE', 'Recovery record is required');
  return stripSecrets(record);
}

function stripSecrets(value, fieldName = '') {
  if (SECRET_FIELDS.test(fieldName)) return undefined;
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item)).filter((item) => item !== undefined);
  if (typeof value === 'bigint') return String(value);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_FIELDS.test(key))
    .map(([key, item]) => [key, stripSecrets(item, key)])
    .filter(([, item]) => item !== undefined));
}

function redactedEvent(event) {
  const safe = sanitizeRecord(event ?? {});
  return {
    transactionId: safe.transactionId,
    action: safe.action,
    protocolVersion: safe.protocolVersion ?? PROTOCOL_VERSION,
    templateHash: safe.templateHash,
    phase: safe.phase,
    confirmationStatus: safe.confirmationStatus ?? safe.status,
  };
}

function number(value) { const result = Number(value); return Number.isFinite(result) ? result : 0; }
function clone(value) { return value === undefined || value === null ? value : structuredClone(value); }
