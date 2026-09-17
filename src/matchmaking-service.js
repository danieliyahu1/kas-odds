import { randomUUID } from 'node:crypto';
import { MIN_STAKE_KAS, ProtocolError, stakeToSompi } from './protocol.js';
import { DEFAULT_NETWORK_PROFILE } from './network.js';
import { normalizePublicKey } from './create-game.js';

const noopLogger = Object.freeze({ info: () => {} });

export class MatchmakingService {
  constructor({ store, metrics, logPlayer, logger = noopLogger, addressPrefix = DEFAULT_NETWORK_PROFILE.addressPrefix }) {
    this.store = store;
    this.metrics = metrics;
    this.logPlayer = logPlayer;
    this.logger = logger;
    this.addressPrefix = addressPrefix;
  }

  async join(input) {
    const address = matchmakingAddress(input.address, this.addressPrefix);
    const publicKey = normalizePublicKey(input.publicKey, 'matchmaking public key');
    const limitKas = input.limitKas === undefined ? MIN_STAKE_KAS : Number(input.limitKas);
    stakeToSompi(limitKas);
    const match = await this.store.joinMatchmaking({ matchId: randomUUID(), address, publicKey, limitKas });
    this.logPlayer('matchmaking_join', address, { matchId: match.matchId, status: match.status, limitKas });
    // Always-on, address-free breadcrumbs: who got paired and who was left
    // waiting is exactly what a stuck matchmaking session needs to explain.
    if (match.status === 'matched' && match.players.length === 2) {
      this.logger.info('matchmaking_paired', { matchId: match.matchId, stakeKas: match.stakeKas });
      this.metrics.recordGameEvent('matchmaking_paired');
      this.logPlayer('matchmaking_paired', match.players[0].address, { matchId: match.matchId, opponentAddress: match.players[1].address, stakeKas: match.stakeKas });
    } else {
      this.logger.info('matchmaking_waiting', { matchId: match.matchId, limitKas });
      this.metrics.recordGameEvent('matchmaking_waiting');
    }
    this.metrics.recordGameEvent('matchmaking_join');
    await this.recordBacklog();
    return matchResponse(match, address);
  }

  // A friend game is a private session: the host fixes the stake and shares the
  // invite id, and neither player can lock funds until the room is matched.
  async createRoom(input) {
    const address = matchmakingAddress(input.address, this.addressPrefix);
    const publicKey = normalizePublicKey(input.publicKey, 'matchmaking public key');
    const stakeKas = Number(input.stakeKas);
    stakeToSompi(stakeKas);
    const match = await this.store.createPrivateMatch({ matchId: randomUUID(), address, publicKey, stakeKas });
    this.logPlayer('matchmaking_room_created', address, { matchId: match.matchId, stakeKas });
    this.logger.info('matchmaking_room_waiting', { matchId: match.matchId, stakeKas });
    this.metrics.recordGameEvent('matchmaking_room_created');
    await this.recordBacklog();
    return matchResponse(match, address);
  }

  async joinRoom(matchId, input) {
    const address = matchmakingAddress(input.address, this.addressPrefix);
    const publicKey = normalizePublicKey(input.publicKey, 'matchmaking public key');
    const match = await this.store.joinPrivateMatch(matchId, { address, publicKey });
    this.logPlayer('matchmaking_room_joined', address, { matchId: match.matchId, stakeKas: match.stakeKas });
    this.logger.info('matchmaking_room_paired', { matchId: match.matchId, stakeKas: match.stakeKas });
    this.metrics.recordGameEvent('matchmaking_room_joined');
    await this.recordBacklog();
    return matchResponse(match, address);
  }

  async status(matchId, address) {
    const playerAddress = matchmakingAddress(address, this.addressPrefix);
    const match = await this.store.loadMatch(matchId);
    try {
      findMatchPlayer(match, playerAddress);
    } catch (error) {
      // A player polling a session that is gone or that never held their wallet
      // is the observable form of "my opponent got matched and I did not".
      this.logger.info('matchmaking_status_miss', { matchId, reason: error.code });
      throw error;
    }
    await this.store.touchMatch(matchId, playerAddress);
    return matchResponse(await this.store.loadMatch(matchId), playerAddress);
  }

  async leave(matchId, address) {
    const playerAddress = matchmakingAddress(address, this.addressPrefix);
    const match = await this.store.loadMatch(matchId);
    findMatchPlayer(match, playerAddress);
    await this.store.leaveMatch(matchId, playerAddress);
    this.logger.info('matchmaking_left', { matchId });
    this.metrics.recordGameEvent('matchmaking_leave');
    await this.recordBacklog();
    return { matchId, status: 'left' };
  }

  async recordBacklog() {
    try {
      this.metrics.setMatchmakingWaiting(await this.store.countWaitingMatches());
    } catch {
      // Telemetry is best-effort and must not affect matchmaking.
    }
  }
}

export function assignedSide(match, playerIndex) {
  return match.creatorSide === (playerIndex === match.creatorIndex ? 'even' : 'odd') ? 'even' : 'odd';
}

export function findMatchPlayer(match, address) {
  if (!match || !Array.isArray(match.players)) throw new ProtocolError('MATCH_NOT_FOUND', 'Matchmaking session was not found');
  const index = match.players.findIndex((player) => player.address === address);
  if (index < 0) throw new ProtocolError('NOT_A_PLAYER', 'This wallet is not part of the matchmaking session');
  return match.players[index];
}

export function matchResponse(match, address) {
  if (!match) throw new ProtocolError('MATCH_NOT_FOUND', 'Matchmaking session was not found');
  const index = match.players.findIndex((player) => player.address === address);
  if (index < 0) throw new ProtocolError('NOT_A_PLAYER', 'This wallet is not part of the matchmaking session');
  const isCreator = match.status !== 'waiting' && index === match.creatorIndex;
  const side = match.status === 'waiting' ? null : assignedSide(match, index);
  const mine = match.players[index];
  const rival = match.players.length === 2 ? match.players[1 - index] : null;
  return {
    matchId: match.matchId, status: match.status,
    role: match.status === 'waiting' ? null : isCreator ? 'creator' : 'joiner',
    side, gameId: match.gameId ?? null, creation: match.creation ?? null,
    stakeKas: match.stakeKas ?? null, myLimitKas: mine.limitKas ?? MIN_STAKE_KAS,
    rivalLimitKas: rival ? rival.limitKas ?? MIN_STAKE_KAS : null,
    opponentConnected: match.players.length === 2,
  };
}

function matchmakingAddress(value, addressPrefix) {
  if (typeof value !== 'string' || !value.startsWith(`${addressPrefix}:`)) throw new ProtocolError('INVALID_ADDRESS', 'Matchmaking requires a wallet on the configured network');
  return value;
}
