import { access, mkdir, readFile, rename, writeFile, constants } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { dirname } from 'node:path';
import { ProtocolError } from './protocol.js';
import { noopMetrics } from './metrics.js';

const MATCH_WAIT_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT_KAS = 1;

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

  async saveGame(record) {
    await this.#update((data) => { data.games[record.gameId] = record; });
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
        if (!['waiting', 'matched', 'ready'].includes(match.status)) continue;
        const lastSeen = Math.min(...match.players.map((player) => Date.parse(player.lastSeenAt ?? player.joinedAt ?? '')));
        if (!Number.isFinite(lastSeen) || now - lastSeen > MATCH_WAIT_TIMEOUT_MS) match.status = 'cancelled';
      }
      data.queue = data.queue.filter((matchId) => data.matches[matchId]?.status === 'waiting');
      const active = Object.values(data.matches).find((match) => ['waiting', 'matched', 'ready'].includes(match.status)
        && match.players.some((item) => item.address === player.address));
      if (active) {
        active.status = 'cancelled';
        data.queue = data.queue.filter((matchId) => matchId !== active.matchId);
      }

      const waiting = data.queue
        .map((matchId) => data.matches[matchId])
        .find((match) => match?.status === 'waiting');
      const limitKas = Number.isInteger(player.limitKas) ? player.limitKas : DEFAULT_LIMIT_KAS;
      const participant = { ...player, limitKas, joinedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), confirmed: false };
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

  async confirmMatchmaking(matchId, address) {
    return this.#updateWithResult((data) => {
      const match = data.matches[matchId];
      if (!match || !Array.isArray(match.players)) return null;
      const player = match.players.find((item) => item.address === address);
      if (!player) return match;
      player.confirmed = true;
      if (match.players.length === 2 && match.players.every((item) => item.confirmed)) {
        match.status = 'ready';
        data.queue = data.queue.filter((id) => id !== matchId);
      }
      return match;
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
      if (['waiting', 'matched', 'ready'].includes(match.status)) {
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
      const temporary = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(data, null, 2));
      await rename(temporary, this.filePath);
      return clone(result);
    }));
    this.writeQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #read() {
    return this.#timed('read', () => this.#readRaw());
  }

  async #readRaw() {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8'));
      return normalizeData(value);
    } catch (error) {
      if (error?.code === 'ENOENT') return normalizeData({});
      throw new ProtocolError('STORAGE_UNAVAILABLE', `Unable to read backend game store: ${error.message}`);
    }
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

function normalizeData(value) {
  return {
    prepared: value.prepared ?? {},
    games: value.games ?? {},
    joinPrepared: value.joinPrepared ?? {},
    actionPrepared: value.actionPrepared ?? {},
    queue: value.queue ?? [],
    matches: value.matches ?? {},
  };
}

function clone(value) {
  return value === null ? null : structuredClone(value);
}
