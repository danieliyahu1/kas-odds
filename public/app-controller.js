export const TERMINAL_GAME_STATUSES = new Set(['settled', 'fallback_claimed', 'refunded', 'creator_refunded']);

export function createPollController({ onPoll, intervalMs, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let timer;
  let generation = 0;
  let running = false;
  const tick = async (key, currentGeneration) => {
    if (running || currentGeneration !== generation) return;
    running = true;
    try { await onPoll(key, currentGeneration); } finally { running = false; }
  };
  return {
    start(key) { this.stop(); const currentGeneration = generation; void tick(key, currentGeneration); timer = setIntervalFn(() => void tick(key, currentGeneration), intervalMs); },
    stop() { generation += 1; if (timer !== undefined) clearIntervalFn(timer); timer = undefined; running = false; },
    get active() { return timer !== undefined; },
    get generation() { return generation; },
  };
}

export function createLatestRequestGate() {
  let revision = 0;
  return { next() { revision += 1; return revision; }, isCurrent(candidate) { return candidate === revision; } };
}

export function isTerminalGameStatus(status) { return TERMINAL_GAME_STATUSES.has(status); }

export const MATCH_VIEW = Object.freeze({
  FINDING: 'finding',
  ABANDONED: 'abandoned',
  REOPEN: 'reopen',
  PLAY: 'play',
});

// A matched match is the same screen for both players: the creator and the
// joiner only differ in which transaction they sign, never in what they see.
export function resolveMatchView(match) {
  if (!match) throw new Error('Matchmaking state is required');
  if (match.status === 'waiting') return MATCH_VIEW.FINDING;
  if (match.status === 'cancelled' || !match.opponentConnected) return MATCH_VIEW.ABANDONED;
  if (match.role === 'creator' && match.gameId) return MATCH_VIEW.REOPEN;
  return MATCH_VIEW.PLAY;
}

// While a player is choosing a number, arriving game metadata must not repaint
// the screen and wipe the selection; an abandoned match still must.
export function shouldRerenderMatch(previous, next, { picking = false } = {}) {
  if (!previous) return true;
  if (next.status === 'cancelled' || !next.opponentConnected) return true;
  if (picking) return false;
  return previous.status !== next.status
    || previous.opponentConnected !== next.opponentConnected
    || previous.gameId !== next.gameId
    || previous.stakeKas !== next.stakeKas;
}

export const MATCH_GAME_WAIT = Object.freeze({ READY: 'ready', CANCELLED: 'cancelled', TIMEOUT: 'timeout', PENDING: 'pending' });

// The joiner can pick his number before the creator publishes the game; he only
// needs the game id once he is ready to sign, so waiting is a poll, an abort on
// cancellation, or a timeout.
export function matchGameWaitState(match, { elapsedMs = 0, timeoutMs = 0 } = {}) {
  if (match?.gameId) return MATCH_GAME_WAIT.READY;
  if (!match || match.status === 'cancelled' || !match.opponentConnected) return MATCH_GAME_WAIT.CANCELLED;
  if (elapsedMs >= timeoutMs) return MATCH_GAME_WAIT.TIMEOUT;
  return MATCH_GAME_WAIT.PENDING;
}

// Maps a protocol error code to the title and message shown to the player. Pure:
// the same code always yields the same copy, so callers (the lobby controller
// and the game page) share one source of truth.
export function actionErrorCopy(error) {
  const copy = {
    STORAGE_MASS_EXCEEDED: ['Transaction not ready', 'Your wallet needs a smaller available coin. Receive a small separate payment, then try again. Your game funds remain safe.'],
    NO_UTXOS: ['Network fee unavailable', 'This wallet needs a small separate balance to pay the network fee.'],
    NO_ORDINARY_UTXOS: ['Network fee unavailable', 'This wallet needs a small separate balance to pay the network fee.'],
    INSUFFICIENT_UTXOS: ['Not enough KAS for the network fee', 'Add a small amount of KAS to this wallet, then try again.'],
    FEE_REPRICING_FAILED: ['Network fee changed', 'The network fee changed while preparing this action. Please try again.'],
    TRANSACTION_REJECTED: ['Transaction not accepted', 'The network did not accept this action. Wait a few seconds, then try again. Your game funds remain safe.'],
    MATCH_TIMEOUT: ['Still waiting for your opponent', 'They did not create the game in time. Try again in a moment.'],
    CREATION_PENDING: ['Almost there', "Your opponent's game is still reaching the network. Try again in a moment."],
    CREATION_FAILED: ['The game did not start', "Your opponent's game did not reach the network. No KAS was locked."],
    GAME_EXPIRED: ['This game expired', 'The joining window closed. No KAS was locked.'],
  }[error?.code] ?? ['Please try again', 'Something went wrong. Please try again in a few seconds. Your game funds remain safe.'];
  return { title: copy[0], message: copy[1] };
}
