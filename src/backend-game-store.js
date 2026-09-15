import { access, mkdir, readFile, rename, unlink, writeFile, constants } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { dirname } from 'node:path';
import { ProtocolError } from './protocol.js';
import { noopMetrics } from './metrics.js';

const MATCH_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT_KAS = 1;
const PREPARATION_RETENTION_MS = 900_000;
// Windows can briefly lock a file being replaced by an atomic rename (antivirus,
// search indexing, another reader). These are transient, so retry a few times
// before surfacing a storage error.
const RENAME_RETRIES = 3;
const RENAME_BACKOFF_MS = 20;
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

// Durable persistence for the backend game engine. Matchmaking sessions, game
// records, and non-secret transaction preparations are written atomically to a
// single JSON file. Reveal preimages are intentionally never stored here; they
// live only in the ephemeral in-memory store.
export class BackendGameStore {
  constructor(filePath, { metrics = noopMetrics } = {}) {
    if (!filePath) throw new ProtocolError('STORAGE_UNAVAILABLE', 'Backend game store path is required');
    this.filePath = filePath;
    this.metrics = metrics;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.pruneExpiredPreparations();
  }

  async pruneExpiredPreparations(now = Date.now()) {
    await this.#update((data) => {
      for (const collection of [data.prepared, data.joinPrepared, data.actionPrepared]) {
        for (const [preparedHash, record] of Object.entries(collection)) {
          const createdAt = Date.parse(record.createdAt ?? '');
          if (Number.isFinite(createdAt) && now - createdAt >= PREPARATION_RETENTION_MS) delete collection[preparedHash];
        }
      }
    });
  }

  async health() {
    return this.#timed('health', async () => {
      await access(dirname(this.filePath), constants.W_OK);
      await this.#readRaw();
      return true;
    });
  }

  async loadPrepared(preparedHash) {
    return clone((await this.#read()).prepared[preparedHash] ?? null);
  }

  async savePrepared(record) {
    await this.#update((data) => { data.prepared[record.preparedHash] = record; });
  }

  async loadGame(gameId) {
    return clone((await this.#read()).games[gameId] ?? null);
  }

  async listGames() {
    return clone(Object.values((await this.#read()).games));
  }

  async saveGame(record) {
    await this.#update((data) => { data.games[record.gameId] = record; });
  }

  async completeGame(record) {
    return this.#updateWithResult((data) => {
      if (!data.games[record.gameId]) return false;
      delete data.games[record.gameId];
      if (record.matchId) {
        delete data.matches[record.matchId];
        data.queue = data.queue.filter((matchId) => matchId !== record.matchId);
      }
      for (const [preparedHash, prepared] of Object.entries(data.prepared)) {
        if (preparedHash === record.creationPreparedHash || prepared.prepared?.txJson === record.prepared?.txJson) {
          delete data.prepared[preparedHash];
        }
      }
      for (const [preparedHash, prepared] of Object.entries(data.joinPrepared)) {
        if (prepared.gameId === record.gameId) delete data.joinPrepared[preparedHash];
      }
      for (const [preparedHash, prepared] of Object.entries(data.actionPrepared)) {
        if (prepared.gameId === record.gameId) delete data.actionPrepared[preparedHash];
      }
      return true;
    });
  }

  async loadJoinPrepared(preparedHash) {
    return clone((await this.#read()).joinPrepared[preparedHash] ?? null);
  }

  async saveJoinPrepared(record) {
    await this.#update((data) => { data.joinPrepared[record.preparedHash] = record; });
  }

  async loadActionPrepared(preparedHash) {
    return clone((await this.#read()).actionPrepared[preparedHash] ?? null);
  }

  async saveActionPrepared(record) {
    await this.#update((data) => { data.actionPrepared[record.preparedHash] = record; });
  }

  async joinMatchmaking(player) {
    return this.#updateWithResult((data) => {
      const now = Date.now();
      for (const match of Object.values(data.matches)) {
        if (!['waiting', 'matched'].includes(match.status)) continue;
        const lastSeen = Math.min(...match.players.map((player) => Date.parse(player.lastSeenAt ?? player.joinedAt ?? '')));
        if (!Number.isFinite(lastSeen) || now - lastSeen > MATCH_WAIT_TIMEOUT_MS) match.status = 'cancelled';
      }
      data.queue = data.queue.filter((matchId) => data.matches[matchId]?.status === 'waiting');
      const active = Object.values(data.matches).find((match) => ['waiting', 'matched'].includes(match.status)
        && match.players.some((item) => item.address === player.address));
      if (active) {
        active.status = 'cancelled';
        data.queue = data.queue.filter((matchId) => matchId !== active.matchId);
      }

      const waiting = data.queue
        .map((matchId) => data.matches[matchId])
        .find((match) => match?.status === 'waiting');
      const limitKas = Number.isInteger(player.limitKas) ? player.limitKas : DEFAULT_LIMIT_KAS;
      const participant = { ...player, limitKas, joinedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() };
      if (!waiting) {
        const match = { matchId: player.matchId, status: 'waiting', players: [participant], stakeKas: null, createdAt: participant.joinedAt };
        data.matches[match.matchId] = match;
        data.queue.push(match.matchId);
        return match;
      }

      waiting.players.push(participant);
      waiting.stakeKas = Math.min(waiting.players[0].limitKas ?? DEFAULT_LIMIT_KAS, participant.limitKas);
      waiting.status = 'matched';
      waiting.creatorIndex = randomInt(2);
      waiting.creatorSide = randomInt(2) === 0 ? 'even' : 'odd';
      data.queue = data.queue.filter((matchId) => matchId !== waiting.matchId);
      return waiting;
    });
  }

  async loadMatch(matchId) {
    return clone((await this.#read()).matches[matchId] ?? null);
  }

  async touchMatch(matchId, address) {
    await this.#update((data) => {
      const match = data.matches[matchId];
      const player = match?.players.find((item) => item.address === address);
      if (player) player.lastSeenAt = new Date().toISOString();
    });
  }

  async saveMatch(match) {
    await this.#update((data) => { data.matches[match.matchId] = match; });
  }

  async updateMatch(matchId, change) {
    return this.#updateWithResult((data) => {
      const match = data.matches[matchId];
      if (!match) return null;
      change(match);
      return match;
    });
  }

  async leaveMatch(matchId, address) {
    await this.#update((data) => {
      const match = data.matches[matchId];
      if (!match) return;
      match.players = match.players.filter((player) => player.address !== address);
      if (['waiting', 'matched'].includes(match.status)) {
        match.status = 'cancelled';
        data.queue = data.queue.filter((id) => id !== matchId);
      }
    });
  }

  async countWaitingMatches() {
    const data = await this.#read();
    return Object.values(data.matches).filter((match) => match?.status === 'waiting').length;
  }

  async #update(change) {
    await this.#updateWithResult((data) => { change(data); });
  }

  async #updateWithResult(change) {
    const operation = this.writeQueue.then(() => this.#timed('write', async () => {
      const data = await this.#readRaw();
      const result = change(data);
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${randomInt(1_000_000_000)}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(data, null, 2));
        await renameWithRetry(temporary, this.filePath);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw new ProtocolError('STORAGE_WRITE_FAILED', `Unable to persist backend game store: ${error.message}`, { cause: error });
      }
      return clone(result);
    }));
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #read() {
    return this.#timed('read', () => this.#readRaw());
  }

  async #readRaw() {
    let raw;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return normalizeData({});
      throw new ProtocolError('STORAGE_UNAVAILABLE', `Unable to read backend game store: ${error.message}`, { cause: error });
    }
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new ProtocolError('STORAGE_CORRUPT', `Backend game store contains invalid JSON: ${error.message}`, { cause: error });
    }
    return normalizeData(value);
  }

  async #timed(operation, run) {
    const startedAt = performance.now();
    let outcome = 'success';
    try {
      return await run();
    } catch (error) {
      outcome = 'error';
      throw error;
    } finally {
      this.metrics.recordStorage({ operation, outcome, durationSeconds: (performance.now() - startedAt) / 1000 });
    }
  }
}

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (attempt >= RENAME_RETRIES || !TRANSIENT_RENAME_CODES.has(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * (attempt + 1)));
    }
  }
}

function normalizeData(value) {
  if (!isRecord(value)) throw new ProtocolError('STORAGE_CORRUPT', 'Backend game store root must be an object');
  for (const name of ['prepared', 'games', 'joinPrepared', 'actionPrepared', 'matches']) {
    if (value[name] !== undefined && !isRecord(value[name])) {
      throw new ProtocolError('STORAGE_CORRUPT', `Backend game store field ${name} must be an object`);
    }
  }
  if (value.queue !== undefined && !Array.isArray(value.queue)) {
    throw new ProtocolError('STORAGE_CORRUPT', 'Backend game store field queue must be an array');
  }
  return {
    prepared: value.prepared ?? {},
    games: value.games ?? {},
    joinPrepared: value.joinPrepared ?? {},
    actionPrepared: value.actionPrepared ?? {},
    queue: value.queue ?? [],
    matches: value.matches ?? {},
  };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === null ? null : structuredClone(value);
}
