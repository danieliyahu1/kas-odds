import { blake2b256 } from './hashes/blake2b.mjs';
import { hexToBytes, bytesToHex } from './hashes/hex.mjs';
import { ProtocolError } from './protocol.js';
import { deadlineAfterDaa, FALLBACK_CLAIM_DAA_OFFSET, TERMINAL_COPY } from './terminal-actions.js';

export const REVEAL_COPY = Object.freeze({
  available: 'Reveal is ready. You will disclose your hidden choice to settle the game.',
  waitingForLocks: 'Waiting for both locked stakes to confirm.',
  missingSecret: 'This browser does not have the unrevealed value for this game.',
  alreadyRevealed: 'Your reveal is already confirmed.',
  waitingForOtherPlayer: 'Your reveal is confirmed. Waiting for the other player.',
  settled: 'The game is settled.',
  invalid: 'The saved reveal value does not match the confirmed commitment.',
  notPlayer: 'Only a player in this game can reveal.',
  transactionPending: TERMINAL_COPY.transactionPending,
  confirmed: 'Reveal confirmed.',
});

export class MemoryRevealStore {
  constructor(records = []) {
    this.records = new Map(records.map((record) => [revealStoreKey(record), clone(record)]));
  }

  async load({ gameId, player }) {
    return clone(this.records.get(revealStoreKey({ gameId, player })) ?? null);
  }

  async save(record) {
    this.records.set(revealStoreKey(record), clone(record));
  }
}

export class IndexedDbRevealStore {
  constructor({ indexedDB = globalThis.indexedDB, databaseName = 'kasodds', storeName = 'reveal-secrets' } = {}) {
    if (!indexedDB) throw new ProtocolError('STORAGE_UNAVAILABLE', 'IndexedDB is required for reveal secrets');
    this.indexedDB = indexedDB;
    this.databaseName = databaseName;
    this.storeName = storeName;
  }

  async load({ gameId, player }) {
    const db = await this.#open();
    return clone(await requestResult(db.transaction(this.storeName, 'readonly').objectStore(this.storeName).get(revealStoreKey({ gameId, player }))));
  }

  async save(record) {
    const db = await this.#open();
    await requestResult(db.transaction(this.storeName, 'readwrite').objectStore(this.storeName).put({ ...clone(record), key: revealStoreKey(record) }));
  }

  #open() {
    const request = this.indexedDB.open(this.databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(this.storeName)) request.result.createObjectStore(this.storeName, { keyPath: 'key' });
    };
    return requestResult(request);
  }
}

export function createRevealSecret({ gameId, player, choice, nonce, nonceHex }) {
  const secret = normalizeRevealSecret({ choice, nonce: nonce ?? nonceHex ?? randomNonce() });
  return Object.freeze({
    gameId: normalizeGameId(gameId),
    player: normalizePlayer(player),
    choice: secret.choice,
    nonceHex: bytesToHex(secret.nonce),
    commitment: revealCommitment(secret),
    createdAt: new Date().toISOString(),
  });
}

export async function saveRevealSecret(store, record) {
  assertRevealStore(store);
  await store.save(normalizeRevealRecord(record));
}

export async function loadRevealSecret(store, { gameId, player }) {
  assertRevealStore(store);
  const record = await store.load({ gameId: normalizeGameId(gameId), player: normalizePlayer(player) });
  return record ? normalizeRevealRecord(record) : null;
}

export function canonicalRevealPreimage({ choice, nonce }) {
  const secret = normalizeRevealSecret({ choice, nonce });
  const out = new Uint8Array(40);
  out.set(encodeI64Fixed(secret.choice), 0);
  out.set(secret.nonce, 8);
  return out;
}

export function revealCommitment({ choice, nonce, nonceHex }) {
  return bytesToHex(blake2b256(canonicalRevealPreimage({ choice, nonce: nonce ?? nonceHex })));
}

export function verifyRevealPreimage({ commitment, choice, nonce, nonceHex }) {
  return normalizeHex32(commitment, 'commitment') === revealCommitment({ choice, nonce, nonceHex });
}

export function parityOutcome({ creatorChoice, joinerChoice, creatorEven }) {
  const creator = normalizeChoice(creatorChoice);
  const joiner = normalizeChoice(joinerChoice);
  return (creator + joiner) % 2 === (creatorEven ? 0 : 1) ? 'creator' : 'joiner';
}

export function resolveReveal({ game, caller, secret, currentDaaScore }) {
  const state = normalizeRevealGame(game);
  const player = normalizePlayer(caller);
  if (!state.players.includes(player)) return decision('refused', false, REVEAL_COPY.notPlayer);
  if (state.terminal === 'settled') return decision('settled', false, REVEAL_COPY.settled);
  if (state.terminal === 'fallback_claimed') return decision('settled', false, TERMINAL_COPY.fallbackConfirmed);
  if (state.confirmationStatus !== 'confirmed' || state.joinedDaaScore === null || normalizeDaa(currentDaaScore ?? state.currentDaaScore, 'current DAA score') <= state.joinedDaaScore) {
    return decision('waiting_for_locks', false, REVEAL_COPY.waitingForLocks);
  }
  if (state.reveals[player]) return decision('already_revealed', false, REVEAL_COPY.alreadyRevealed);
  if (state.firstReveal && state.firstReveal.player === player) return decision('waiting_for_other_player', false, REVEAL_COPY.waitingForOtherPlayer);
  if (!secret) return decision('missing_secret', false, REVEAL_COPY.missingSecret);
  const record = normalizeRevealRecord(secret);
  if (record.gameId !== state.gameId || record.player !== player) return decision('missing_secret', false, REVEAL_COPY.missingSecret);
  if (!verifyRevealPreimage({ commitment: state.commitments[player], choice: record.choice, nonceHex: record.nonceHex })) {
    return decision('invalid', false, REVEAL_COPY.invalid);
  }
  return decision('available', true, REVEAL_COPY.available, {
    action: 'reveal',
    player,
    choice: record.choice,
    nonceHex: record.nonceHex,
    fallbackDeadlineDaa: state.firstReveal ? undefined : deadlineAfterDaa(currentDaaScore ?? state.currentDaaScore, FALLBACK_CLAIM_DAA_OFFSET),
  });
}

export function revealActionView(decisionValue) {
  if (!decisionValue || typeof decisionValue !== 'object') {
    return Object.freeze({ action: 'reveal', state: 'unknown', canSubmit: false, message: TERMINAL_COPY.stateUnknown });
  }
  return Object.freeze({
    action: 'reveal',
    state: decisionValue.available ? 'available' : decisionValue.status,
    canSubmit: decisionValue.available === true,
    message: decisionValue.message,
    fallbackDeadlineDaa: decisionValue.fallbackDeadlineDaa,
  });
}

export function normalizeRevealGame(game) {
  if (!game || typeof game !== 'object') throw new ProtocolError('INVALID_GAME_STATE', 'Game state is required');
  const gameId = normalizeGameId(game.gameId);
  const participants = game.participants;
  if (!participants || typeof participants !== 'object' || Array.isArray(participants)) {
    throw new ProtocolError('INVALID_GAME_STATE', 'Participants are required');
  }
  const players = Object.keys(participants);
  if (players.length !== 2) throw new ProtocolError('INVALID_GAME_STATE', 'Exactly two participants are required');
  const commitments = {};
  const reveals = {};
  for (const player of players) {
    commitments[player] = normalizeHex32(participants[player]?.commitment ?? game.commitments?.[player], `${player} commitment`);
    reveals[player] = Boolean(game.reveals?.[player]);
  }
  const joinedDaaScore = game.joinedDaaScore === undefined || game.joinedDaaScore === null ? null : normalizeDaa(game.joinedDaaScore, 'joined DAA score');
  return Object.freeze({
    gameId,
    participants,
    players,
    commitments,
    reveals,
    firstReveal: normalizeFirstReveal(game.firstReveal, players),
    joinedDaaScore,
    currentDaaScore: game.currentDaaScore === undefined ? joinedDaaScore : normalizeDaa(game.currentDaaScore, 'current DAA score'),
    confirmationStatus: game.confirmationStatus ?? null,
    terminal: game.terminal ?? null,
  });
}

function normalizeRevealRecord(record) {
  const secret = normalizeRevealSecret({ choice: record.choice, nonce: record.nonce ?? record.nonceHex });
  return Object.freeze({
    gameId: normalizeGameId(record.gameId),
    player: normalizePlayer(record.player),
    choice: secret.choice,
    nonceHex: bytesToHex(secret.nonce),
    commitment: record.commitment ? normalizeHex32(record.commitment, 'commitment') : revealCommitment(secret),
    createdAt: record.createdAt,
  });
}

function normalizeRevealSecret({ choice, nonce }) {
  return { choice: normalizeChoice(choice), nonce: normalizeBytes32(nonce, 'nonce') };
}

function normalizeFirstReveal(reveal, players) {
  if (!reveal) return null;
  if (!players.includes(reveal.player)) throw new ProtocolError('INVALID_GAME_STATE', 'Reveal player must be a participant');
  return Object.freeze({ player: reveal.player, confirmedDaaScore: normalizeDaa(reveal.confirmedDaaScore, 'confirmed DAA score') });
}

function encodeI64Fixed(value) {
  let remaining = BigInt(value);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function normalizeChoice(choice) {
  if (choice === 0 || choice === 1) return choice;
  throw new ProtocolError('INVALID_REVEAL', 'Reveal choice must be 0 or 1');
}

function normalizeBytes32(value, name) {
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
    if (value.length === 32) return Uint8Array.from(value);
  }
  if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) return hexToBytes(value);
  throw new ProtocolError('INVALID_REVEAL', `${name} must be 32 bytes`);
}

function normalizeHex32(value, name) {
  if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) return bytesToHex(normalizeBytes32(value, name));
  throw new ProtocolError('INVALID_GAME_STATE', `${name} must be a 32-byte hexadecimal value`);
}

function normalizeGameId(gameId) {
  if (typeof gameId === 'string' && /^[0-9a-f]{64}$/i.test(gameId)) return gameId.toLowerCase();
  throw new ProtocolError('INVALID_GAME_ID', 'Game identifier must be a 32-byte hexadecimal value');
}

function normalizePlayer(player) {
  if (typeof player === 'string' && player.length > 0) return player;
  throw new ProtocolError('INVALID_GAME_STATE', 'Player is required');
}

function normalizeDaa(value, name) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new ProtocolError('INVALID_GAME_STATE', `${name} must be a non-negative integer`);
}

function revealStoreKey({ gameId, player }) {
  return `${normalizeGameId(gameId)}:${normalizePlayer(player)}`;
}

function assertRevealStore(store) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') throw new ProtocolError('STORAGE_UNAVAILABLE', 'Reveal secret storage is required');
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new ProtocolError('STORAGE_UNAVAILABLE', request.error?.message ?? 'IndexedDB request failed'));
  });
}

function decision(status, available, message, extra = {}) {
  return Object.freeze({ status, available, message, ...extra });
}

function clone(value) {
  return value === null || value === undefined ? value : structuredClone(value);
}

function randomNonce() {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new ProtocolError('CRYPTO_UNAVAILABLE', 'Secure random nonce generation is required');
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}
