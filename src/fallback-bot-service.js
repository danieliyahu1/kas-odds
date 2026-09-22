// Fallback opponent for testers who cannot find a human.
//
// The waiting player is always the match creator; the bot takes the second seat
// only after the human explicitly accepts the offer. From there the bot behaves
// like a normal joiner: it commits, signs its join, reveals its number when the
// joined escrow confirms, and lets the existing permissionless settlement keeper
// cover any timeout. Every step is derived from persisted state, so a restart
// resumes exactly where it stopped instead of stranding a funded game.
import { randomInt } from 'node:crypto';
import { createRevealSecret } from './reveal.js';
import { noopMetrics } from './metrics.js';

const noopLogger = Object.freeze({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} });

// Expected "not yet" states. The next scan retries them; they are not failures.
const TRANSIENT_CODES = new Set([
  'ACTION_NOT_CONFIRMED', 'ACTION_PENDING', 'GAME_NOT_CONFIRMED', 'CREATION_PENDING',
  'GAME_NOT_OPEN', 'REVEAL_WAITING', 'MATCH_NOT_READY', 'GAME_NOT_JOINED', 'GAME_NOT_FOUND',
]);

export class FallbackBotService {
  constructor({
    gameService, store, wallet,
    metrics = noopMetrics, logger = noopLogger,
    intervalMs = 2_000, unfundedTimeoutMs = 300_000, now = Date.now,
  }) {
    this.gameService = gameService;
    this.store = store;
    this.wallet = wallet;
    this.metrics = metrics;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.unfundedTimeoutMs = unfundedTimeoutMs;
    this.now = now;
    this.running = false;
    this.failures = new Map();
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      for (const match of await this.store.listMatches()) await this.#guard('match', match.matchId, () => this.#advanceMatch(match));
      for (const game of await this.store.listGames()) await this.#guard('game', game.gameId, () => this.#advanceGame(game));
    } finally {
      this.running = false;
    }
  }

  async #guard(scope, id, run) {
    const key = `${scope}:${id}`;
    try {
      await run();
      this.failures.delete(key);
    } catch (error) {
      const fields = { scope, id, code: error?.code, message: error?.message };
      if (TRANSIENT_CODES.has(error?.code)) {
        this.logger.debug('bot_step_deferred', fields);
        return;
      }
      // A persistent failure (for example an underfunded bot) is logged once per
      // distinct code instead of on every scan.
      if (this.failures.get(key) === error?.code) return;
      this.failures.set(key, error?.code);
      this.metrics.recordBotEvent('step_failed');
      this.logger.warn('bot_step_failed', fields);
    }
  }

  async #advanceMatch(match) {
    if (match.botAddress !== this.wallet.address) return;
    if (match.status === 'cancelled') {
      await this.store.releaseBotLease(match.matchId);
      return;
    }
    // The human has accepted the bot but has not published the game yet. Release
    // the single lease if they never do, so the bot is not held indefinitely.
    if (match.status === 'matched' && !match.gameId) {
      const since = Date.parse(match.botClaimedAt ?? match.createdAt ?? '');
      if (Number.isFinite(since) && this.now() - since > this.unfundedTimeoutMs) {
        await this.store.updateMatch(match.matchId, (current) => { current.status = 'cancelled'; });
        await this.store.releaseBotLease(match.matchId);
        this.metrics.recordBotEvent('expired_unfunded');
        this.logger.info('bot_match_expired', { matchId: match.matchId });
      }
      return;
    }
    if (match.status === 'started' && match.gameId) await this.#ensureJoin(match.gameId, match.matchId);
  }

  async #ensureJoin(gameId, matchId) {
    const game = await this.store.loadGame(gameId);
    if (!game || game.join?.transactionId) return;
    const secret = await this.#botSecret(gameId);
    const prepared = await this.gameService.prepareJoin(gameId, {
      joinerAddress: this.wallet.address,
      joinerPublicKey: this.wallet.publicKey,
      joinerCommitment: secret.commitment,
      matchId,
    });
    const signedTxJson = this.wallet.sign(prepared.txJson);
    await this.gameService.submitJoin(gameId, { preparedHash: prepared.preparedHash, signedTxJson });
    this.metrics.recordBotEvent('join_submitted');
    this.logger.info('bot_join_submitted', { matchId });
  }

  // The bot picks a fresh number and nonce and persists them before it joins, so
  // a restart resumes with the exact secret behind the commitment it published.
  async #botSecret(gameId) {
    const existing = await this.store.loadBotSecret(gameId);
    if (existing) return existing;
    const secret = createRevealSecret({ gameId, player: this.wallet.address, choice: randomInt(2) });
    await this.store.saveBotSecret(gameId, { choice: secret.choice, nonceHex: secret.nonceHex, commitment: secret.commitment });
    return secret;
  }

  async #advanceGame(game) {
    if (game.join?.joinerAddress !== this.wallet.address) return;
    if (game.completedAt) {
      if (game.matchId) await this.store.releaseBotLease(game.matchId);
      return;
    }
    if ((game.reveals ?? []).some((reveal) => reveal.playerAddress === this.wallet.address)) return;
    const secret = await this.store.loadBotSecret(game.gameId);
    if (!secret) return;
    const view = await this.gameService.readGame(game.gameId);
    if (!view.canReveal) return;
    const prepared = await this.gameService.prepareReveal(game.gameId, {
      playerAddress: this.wallet.address,
      playerPublicKey: this.wallet.publicKey,
      choice: secret.choice,
      nonceHex: secret.nonceHex,
    });
    const signedTxJson = this.wallet.sign(prepared.txJson);
    await this.gameService.submitReveal(game.gameId, { preparedHash: prepared.preparedHash, signedTxJson });
    this.metrics.recordBotEvent('reveal_submitted');
    this.logger.info('bot_reveal_submitted', { gameId: game.gameId });
  }
}
