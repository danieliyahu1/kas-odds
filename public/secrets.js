// Browser-local reveal-secret storage for Even/Odd.
//
// Each game's hidden number is committed on-chain as blake2b256(choice_le64 ||
// nonce). The covenant (even_odd.sil `reveal`) re-derives that exact preimage,
// so the commitment format is fixed and must never be "domain separated" here.
// Secrecy comes entirely from the 32-byte nonce being unpredictable per game.
//
// Secrets are stored only in this browser's IndexedDB. There is no cloud
// backup and no server copy: clearing site data or switching browsers before
// reveal makes the locked stake unrecoverable through the normal interface.
import { blake2b256 } from '/src/hashes/blake2b.mjs';

const DB_NAME = 'kaspa-even-odd';
const STORE_NAME = 'reveal-secrets';
const SECRET_PREFIX = 's:';
const LINK_PREFIX = 'g:';
const OPERATION_PREFIX = 'o:';
let writeQueue = Promise.resolve();

export function randomNonce() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure randomness is unavailable in this browser');
  return crypto.getRandomValues(new Uint8Array(32));
}

function randomId(bytes = 16) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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

function revealPreimage(choice, nonce) {
  const out = new Uint8Array(40);
  out.set(encodeI64Fixed(choice), 0);
  out.set(nonce, 8);
  return out;
}

export function commitmentFor(choice, nonce) {
  if (choice !== 0 && choice !== 1) throw new Error('Choice must be 0 or 1');
  return bytesToHex(blake2b256(revealPreimage(choice, nonce)));
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error('IndexedDB is unavailable in this browser'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB failed to open'));
  });
}

async function transaction(mode, action) {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, mode);
  const store = tx.objectStore(STORE_NAME);
  return new Promise((resolve, reject) => {
    let result;
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error ?? new Error('IndexedDB transaction failed')); };
    tx.onabort = () => { db.close(); reject(tx.error ?? new Error('IndexedDB transaction aborted')); };
    try { result = action(store); } catch (error) { tx.abort(); reject(error); }
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

async function get(key) {
  return transaction('readonly', (store) => requestResult(store.get(key)));
}

function queueWrite(action) {
  const operation = writeQueue.then(action);
  writeQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

// Generates a fresh secret, persists it, and returns only the opaque secretId
// and commitment. The nonce and choice never leave this function's caller and
// are only re-read at reveal. The transaction completion event guarantees the
// secret is durable before the wallet is ever asked to lock funds.
export async function createRevealSecret(choice, { operationKey = randomId() } = {}) {
  if (choice !== 0 && choice !== 1) throw new Error('Choice must be 0 or 1');
  if (typeof operationKey !== 'string' || operationKey.length === 0) throw new Error('operationKey is required');
  return queueWrite(async () => {
    const existing = await get(`${OPERATION_PREFIX}${operationKey}`);
    if (existing?.secretId) {
      const record = await get(`${SECRET_PREFIX}${existing.secretId}`);
      if (!record) throw new Error('Stored reveal operation is missing its secret');
      if (record.choice !== choice) throw new Error('A different number is already committed for this pending action');
      return { secretId: existing.secretId, commitment: record.commitment };
    }
    const nonce = randomNonce();
    const secretId = randomId();
    const record = { key: `${SECRET_PREFIX}${secretId}`, choice, nonceHex: bytesToHex(nonce), commitment: commitmentFor(choice, nonce) };
    await transaction('readwrite', (store) => {
      store.put(record);
      store.put({ key: `${OPERATION_PREFIX}${operationKey}`, secretId, operationKey, status: 'prepared' });
    });
    return { secretId, commitment: record.commitment };
  });
}

export async function bindSecretToGame(gameId, secretId) {
  if (!gameId || !secretId) throw new Error('gameId and secretId are required');
  return queueWrite(async () => {
    const record = await get(`${SECRET_PREFIX}${secretId}`);
    if (!record) throw new Error('Reveal secret does not exist');
    const operation = await getBySecretId(secretId);
    await transaction('readwrite', (store) => store.put({ key: `${LINK_PREFIX}${gameId}`, secretId, operationKey: operation?.operationKey }));
  });
}

export async function loadSecretForGame(gameId) {
  const link = await get(`${LINK_PREFIX}${gameId}`);
  if (!link?.secretId) return null;
  const record = await get(`${SECRET_PREFIX}${link.secretId}`);
  if (!record) return null;
  return { choice: record.choice, nonceHex: record.nonceHex, commitment: record.commitment };
}

// Removes a game's reveal secret and its link once the nonce is public or no
// longer needed (settled, claimed, or refunded). Safe to call repeatedly.
export async function deleteSecretForGame(gameId) {
  if (!gameId) return;
  return queueWrite(async () => {
    const link = await get(`${LINK_PREFIX}${gameId}`);
    if (!link) return;
    const operation = link.operationKey ? await get(`${OPERATION_PREFIX}${link.operationKey}`) : null;
    await transaction('readwrite', (store) => {
      store.delete(`${LINK_PREFIX}${gameId}`);
      if (link.secretId) store.delete(`${SECRET_PREFIX}${link.secretId}`);
      if (operation) store.delete(`${OPERATION_PREFIX}${link.operationKey}`);
    });
  });
}

export async function reconcileRevealSecrets() {
  const records = await transaction('readonly', (store) => requestResult(store.getAll()));
  const links = records.filter((record) => record.key.startsWith(LINK_PREFIX));
  const operations = records.filter((record) => record.key.startsWith(OPERATION_PREFIX));
  const linkedSecretIds = new Set(links.map((link) => link.secretId));
  return Object.freeze({
    bound: Object.freeze(links.map(({ key, secretId, operationKey }) => ({ gameId: key.slice(LINK_PREFIX.length), secretId, operationKey }))),
    pending: Object.freeze(operations.map(({ operationKey, secretId, status }) => ({ operationKey, secretId, status, bound: linkedSecretIds.has(secretId) }))),
  });
}

// Explicitly abandons a draft that was never funded. This is intentionally not
// part of automatic reconciliation: an unbound secret may belong to a broadcast
// whose response was lost.
export async function abandonRevealOperation(operationKey) {
  if (!operationKey) return;
  return queueWrite(async () => {
    const operation = await get(`${OPERATION_PREFIX}${operationKey}`);
    if (!operation) return;
    await transaction('readwrite', (store) => {
      store.delete(`${OPERATION_PREFIX}${operationKey}`);
      store.delete(`${SECRET_PREFIX}${operation.secretId}`);
    });
  });
}

async function getBySecretId(secretId) {
  const records = await transaction('readonly', (store) => requestResult(store.getAll()));
  return records.find((record) => record.key.startsWith(OPERATION_PREFIX) && record.secretId === secretId);
}
