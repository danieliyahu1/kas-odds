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
    start(key, { immediate = true } = {}) { this.stop(); const currentGeneration = generation; if (immediate) void tick(key, currentGeneration); timer = setIntervalFn(() => void tick(key, currentGeneration), intervalMs); },
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

// The four states a player can be shown. The heading names the exact state; the
// rail deliberately shows only the two moves a game is made of. A public match
// and a friend room share the states; only the copy differs for who is watching
// (a stranger, an invited friend, or the invited guest).
export const GAME_STAGE = Object.freeze({
  VOTE: 'vote',
  VOTE_WAIT: 'vote-wait',
  LOCKING: 'locking',
  REVEAL: 'reveal',
  REVEAL_WAIT: 'reveal-wait',
});

// The rail is a promise about tempo: two moves, never "waiting for the other
// player". Waiting is carried by the heading, not by an empty node.
const RAIL = Object.freeze([
  { key: 'vote', label: 'Vote' },
  { key: 'reveal', label: 'Reveal' },
]);

const PHASE_OF_STAGE = Object.freeze({
  [GAME_STAGE.VOTE]: 'vote',
  [GAME_STAGE.VOTE_WAIT]: 'vote',
  [GAME_STAGE.LOCKING]: 'vote',
  [GAME_STAGE.REVEAL]: 'reveal',
  [GAME_STAGE.REVEAL_WAIT]: 'reveal',
});

export const STAGE_AUDIENCE = Object.freeze({ PUBLIC: 'public', FRIEND: 'friend', GUEST: 'guest' });

const STAGE_COPY = Object.freeze({
  [GAME_STAGE.VOTE]: { public: 'Your turn to vote', friend: 'Your turn to vote', guest: 'Your turn to vote' },
  // Once Play is pressed the choice is made. Preparing, signing, and the creator's
  // transaction landing are one mechanical lock, never another turn and never a
  // wait on the opponent, so both players read the same line.
  [GAME_STAGE.LOCKING]: { public: 'Locking your number', friend: 'Locking your number', guest: 'Locking your number' },
  [GAME_STAGE.VOTE_WAIT]: { public: 'Waiting for the other person to vote', friend: 'Waiting for your friend to vote', guest: 'Waiting for your friend to vote' },
  [GAME_STAGE.REVEAL]: { public: 'Your turn to reveal', friend: 'Your turn to reveal', guest: 'Your turn to reveal' },
  // Revealing is one shared move, so the wait is never framed as the opponent's
  // turn: both players see the same in-progress state until the result lands.
  [GAME_STAGE.REVEAL_WAIT]: { public: 'Revealing...', friend: 'Revealing...', guest: 'Revealing...' },
});

// Lobby phases mirror LOBBY_PHASE by value; the literals keep this module a leaf
// (lobby-controller imports it, never the other way around). Waiting for an
// opponent to appear is not a stage: the rail begins once they are matched.
const LOBBY_STAGE = Object.freeze({
  pick: GAME_STAGE.VOTE,
});

function audienceForMode(mode) {
  if (mode === 'public') return STAGE_AUDIENCE.PUBLIC;
  if (mode === 'guest') return STAGE_AUDIENCE.GUEST;
  return STAGE_AUDIENCE.FRIEND;
}

function audienceForGame(game) {
  return game.matchmaking ? STAGE_AUDIENCE.PUBLIC : STAGE_AUDIENCE.FRIEND;
}

function stageLabel(stage, audience) {
  const copy = STAGE_COPY[stage];
  if (!copy) return null;
  return copy[audience] ?? copy.public;
}

function stageRail(stage) {
  const current = RAIL.findIndex((node) => node.key === PHASE_OF_STAGE[stage]);
  if (current < 0) return [];
  return RAIL.map((node, index) => ({
    key: node.key,
    label: node.label,
    state: index === current ? 'current' : index < current ? 'done' : 'ahead',
  }));
}

function stageOfLobby({ phase }) {
  // Pick is the only decision a player makes in the lobby. Everything after Play
  // is the same lock for both players, whatever the chain is doing in the
  // background, so neither role is ever parked on the other.
  if (phase === 'preparing' || phase === 'wallet') return GAME_STAGE.LOCKING;
  return LOBBY_STAGE[phase] ?? null;
}

// The lobby stage a player is on, or null before the match begins (waiting for
// an opponent or a friend, entering a stake or limit, reconnecting, abandoned,
// or an error).
export function lobbyStage(input) {
  const stage = stageOfLobby(input);
  if (!stage) return null;
  const audience = audienceForMode(input.mode);
  return { stage, title: stageLabel(stage, audience), rail: stageRail(stage) };
}

function hasRevealPending(game, role) {
  return (game.pendingReveals ?? []).some((reveal) => reveal.role === role);
}

function hasRevealed(game, role) {
  return game.revealedPicks?.[role] !== undefined || hasRevealPending(game, role);
}

export function isRevealPhase(game) {
  return game.canReveal === true
    || (game.pendingReveals ?? []).length > 0
    || Object.keys(game.revealedPicks ?? {}).length > 0;
}

function isGameOver(status) {
  return isTerminalGameStatus(status) || status === 'refund_partial';
}

function stageOfGame(game, role) {
  if (role !== 'creator' && role !== 'joiner') return null;
  if (isGameOver(game.status)) return null;
  // My own reveal decides my wait. The other player's in-flight lead reveal must
  // not turn my "your turn" into "Revealing..." while I have not revealed yet.
  if (hasRevealed(game, role)) return GAME_STAGE.REVEAL_WAIT;
  if (!isRevealPhase(game)) return GAME_STAGE.VOTE_WAIT;
  return GAME_STAGE.REVEAL;
}

function gameStageTitle(game, role, stage, audience) {
  if (game.status === 'join_broadcast') return 'Confirming your vote.';
  if (hasRevealPending(game, role)) return 'Revealing...';
  return stageLabel(stage, audience);
}

// The game-page stage for a player, or null for a finished game or a viewer.
export function gameStage(game, role) {
  const stage = stageOfGame(game, role);
  if (!stage) return null;
  const audience = audienceForGame(game);
  return {
    stage,
    title: gameStageTitle(game, role, stage, audience),
    rail: stageRail(stage),
    loading: stage !== GAME_STAGE.REVEAL,
  };
}

// The fields whose change makes the game panel worth re-painting. Per-second
// values are excluded on purpose: the clock ticks locally, and only the
// readiness flip should force a repaint (a repaint would rebuild the reveal
// control and wipe anything in progress).
export function gameSignature(game) {
  return [game.status, game.chainReady, game.safetyAction, game.safetyReady, game.automaticAction, game.automaticReady, game.firstRevealer, game.winner,
    (game.pendingReveals ?? []).map((item) => `${item.role}:${item.retryable}`).join(','),
    (game.pendingSafety ?? []).map((item) => `${item.action}:${item.role}:${item.retryable}`).join(',')].join('|');
}

export function formatWait(seconds) {
  const total = Math.max(0, Math.ceil(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// The timeout the covenant enforces right now, named for the player and paired
// with one sentence explaining the on-chain rule it comes from. The countdown
// number is the server's covenant-derived remaining time; the browser never
// re-derives the rule (it lives once, in the chain's SilverScript and in
// src/terminal-actions.js).
const COVENANT_CLOCK = Object.freeze({
  refund_open: Object.freeze({
    label: 'Refund',
    note: 'When the join deadline passes, the contract returns the stake, minus the relay network fee. Anyone can relay it.',
  }),
  refund_all: Object.freeze({
    label: 'Refund',
    note: 'If neither player reveals by the timeout, the contract returns both stakes, minus the relay network fee. Anyone can relay it.',
  }),
  fallback_claim: Object.freeze({
    label: 'Claim',
    note: 'If the other player never reveals, the contract pays the pot to the first revealer, minus the network and game fees.',
    firstRevealerOnly: true,
  }),
});

export function covenantClock(game, { isFirstRevealer = false } = {}) {
  const entry = COVENANT_CLOCK[game.automaticAction];
  if (!entry || (entry.firstRevealerOnly && !isFirstRevealer)) return null;
  const ready = game.automaticReady === true;
  return {
    label: entry.label,
    note: entry.note,
    ready,
    remainingSeconds: ready ? 0 : game.automaticRemainingSeconds ?? null,
  };
}

// The closing notice on a finished game. The shape is shared, but the copy is per
// person wherever the payout is: a fallback claim is the one terminal outcome that
// pays a single player, so only the first revealer "took the pot". Refunds return
// each stake to its holder, so both players read the same sentence.
export function terminalNotice(game, role) {
  if (game.status === 'fallback_claimed') return fallbackClaimNotice(game, role);
  if (game.status === 'refunded' || game.status === 'creator_refunded') {
    return { title: 'Canceled.', message: isPlayer(role) ? 'Your stake was returned.' : 'The stake was returned.' };
  }
  if (game.status === 'refund_partial') return { title: 'Partial refund.', message: 'One stake was returned. The other player can still refund theirs.' };
  return null;
}

// The fallback pot pays one of the two seats, so this is the only terminal notice
// that must speak to who the caller is.
function fallbackClaimNotice(game, role) {
  if (!isPlayer(role)) return { title: 'Pot claimed.', message: 'The first revealer took the pot.' };
  const friend = game.matchmaking ? 'opponent' : 'friend';
  return firstRevealerIs(game, role)
    ? { title: 'Pot claimed.', message: `Your ${friend} never revealed, so you took the pot.` }
    : { title: 'Pot claimed.', message: `You never revealed, so your ${friend} took the pot.` };
}

function isPlayer(role) {
  return role === 'creator' || role === 'joiner';
}

// The fallback pot pays the first revealer, so "who took the pot" is that person;
// the caller's role decides whether the copy says "you" or "they".
function firstRevealerIs(game, role) {
  if (role === 'creator') return game.firstRevealer === game.creator?.address;
  if (role === 'joiner') return game.firstRevealer === game.joiner?.address;
  return false;
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
    REVEAL_WAITING: ['Revealing...', 'Still revealing. This can take a moment. Try again if it does not finish.'],
    CHAIN_NOT_READY: ['Waiting for the chain', 'The next step is still settling on-chain. This can take a moment. Your game funds remain safe.'],
    MATCH_TIMEOUT: ['Still waiting for your opponent', 'They did not create the game in time. Try again in a moment.'],
    CREATION_PENDING: ['Almost there', "Your opponent's game is still reaching the network. Try again in a moment."],
    CREATION_FAILED: ['The game did not start', "Your opponent's game did not reach the network. No KAS was locked."],
    GAME_EXPIRED: ['This game expired', 'The joining window closed. No KAS was locked.'],
    GAME_CANCELLED: ['The game was canceled', 'Find another player to play against. No KAS was locked.'],
  }[error?.code] ?? ['Please try again', 'Something went wrong. Please try again in a few seconds. Your game funds remain safe.'];
  return { title: copy[0], message: copy[1] };
}
