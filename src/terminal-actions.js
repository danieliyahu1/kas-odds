import { gameFeeSompi, winnerPayoutSompi, ProtocolError } from './protocol.js';

// testnet-10 targets 10 BPS. The PRD's five-minute waits therefore pin to
// 300 seconds * 10 DAA-score increments per second.
export const TESTNET10_DAA_PER_SECOND = 10n;
export const FIVE_MINUTE_DAA_OFFSET = 300n * TESTNET10_DAA_PER_SECOND;
export const FALLBACK_CLAIM_DAA_OFFSET = FIVE_MINUTE_DAA_OFFSET;
export const NO_REVEAL_REFUND_DAA_OFFSET = FIVE_MINUTE_DAA_OFFSET;

// Pure readiness check shared by the backend and the browser: a refund/claim is
// available once the current DAA score reaches the anchor DAA score.
export function safetyReadiness(currentDaaScore, readyAtDaa) {
  const current = BigInt(currentDaaScore);
  const readyAt = BigInt(readyAtDaa);
  const ready = current >= readyAt;
  const remainingSeconds = ready ? 0 : Math.ceil(Number(readyAt - current) / Number(TESTNET10_DAA_PER_SECOND));
  return { ready, remainingSeconds };
}

export const TERMINAL_COPY = Object.freeze({
  fallbackUnavailable: 'The fallback claim is not available yet.',
  fallbackConfirmed: 'Fallback claim confirmed. You receive the pot.',
  settledBySecondReveal: 'The game was settled by the second reveal.',
  gameStateChanged: 'The game state changed. Refresh before trying again.',
  refundConfirmed: 'Your refund is confirmed.',
  transactionPending: 'Transaction status is pending confirmation.',
  stateUnknown: 'Game state is not yet available.',
  stateConflicting: 'Game state is conflicting and cannot be shown as settled.',
});

export function deadlineAfterDaa(confirmedDaaScore, offset = FIVE_MINUTE_DAA_OFFSET) {
  return normalizeDaa(confirmedDaaScore, 'confirmed DAA score') + normalizeDaa(offset, 'DAA offset');
}

export function resolveFallbackClaim({ game, caller, currentDaaScore }) {
  const state = normalizeGameState(game);
  if (state.terminal === 'settled') {
    return decision('already_complete', false, TERMINAL_COPY.settledBySecondReveal);
  }
  if (state.terminal === 'fallback_claimed') {
    return decision('confirmed', false, TERMINAL_COPY.fallbackConfirmed);
  }
  if (!state.firstReveal) {
    return decision('unavailable', false, TERMINAL_COPY.fallbackUnavailable);
  }
  if (caller !== state.firstReveal.player) {
    return decision('refused', false, 'Only the first valid revealer can claim the fallback pot.');
  }
  if (state.secondReveal && winsBeforeOrAt(state.secondReveal, state.fallbackClaim)) {
    return decision('already_complete', false, TERMINAL_COPY.settledBySecondReveal);
  }
  if (state.fallbackClaim && winsBeforeOrAt(state.fallbackClaim, state.secondReveal)) {
    return decision('confirmed', false, TERMINAL_COPY.fallbackConfirmed);
  }
  if (normalizeDaa(currentDaaScore, 'current DAA score') < state.firstReveal.fallbackDeadlineDaa) {
    return decision('unavailable', false, TERMINAL_COPY.fallbackUnavailable, {
      availableDaaScore: state.firstReveal.fallbackDeadlineDaa,
    });
  }
  return decision('available', true, 'Fallback claim is available.', {
    action: 'fallback_claim',
    player: state.firstReveal.player,
  });
}

export function terminalActionView(action, decision) {
  if (!decision || typeof decision !== 'object') {
    return Object.freeze({ action, state: 'unknown', canSubmit: false, message: TERMINAL_COPY.stateUnknown });
  }
  const state = decision.available ? 'available' : decision.status;
  return Object.freeze({
    action,
    state,
    canSubmit: decision.available === true,
    message: decision.message,
    availableDaaScore: decision.availableDaaScore,
  });
}

export function validateFallbackClaimTemplate({ game, caller, currentDaaScore, transaction }) {
  const state = normalizeGameState(game);
  const resolved = resolveFallbackClaim({ game: state, caller, currentDaaScore });
  if (!resolved.available) throw new ProtocolError('ACTION_UNAVAILABLE', resolved.message);
  const tx = parseTransaction(transaction);
  const player = state.participants[caller];
  assertSinglePayout(tx, winnerPayoutSompi(state.stakeSompi), player.scriptPublicKey, 'fallback claim payout');
  assertGameFeeOutput(tx, gameFeeSompi(state.stakeSompi));
  assertFeeSeparated(tx);
  return tx;
}

function normalizeGameState(game) {
  if (!game || typeof game !== 'object') throw new ProtocolError('INVALID_GAME_STATE', 'Game state is required');
  const stakeSompi = normalizePositiveBigInt(game.stakeSompi, 'stake sompi');
  const potSompi = normalizePositiveBigInt(game.potSompi, 'pot sompi');
  const participants = normalizeParticipants(game.participants);
  const players = Object.keys(participants);
  const joinedDaaScore = normalizeDaa(game.joinedDaaScore, 'joined DAA score');
  const noRevealRefundDeadlineDaa = game.noRevealRefundDeadlineDaa === undefined
    ? deadlineAfterDaa(joinedDaaScore, NO_REVEAL_REFUND_DAA_OFFSET)
    : normalizeDaa(game.noRevealRefundDeadlineDaa, 'no-reveal refund deadline DAA score');
  const firstReveal = normalizeReveal(game.firstReveal, players);
  if (firstReveal && firstReveal.fallbackDeadlineDaa === undefined) {
    firstReveal.fallbackDeadlineDaa = deadlineAfterDaa(firstReveal.confirmedDaaScore, FALLBACK_CLAIM_DAA_OFFSET);
  }
  return Object.freeze({
    stakeSompi,
    potSompi,
    participants,
    players,
    joinedDaaScore,
    noRevealRefundDeadlineDaa,
    firstReveal,
    secondReveal: normalizeReveal(game.secondReveal, players),
    fallbackClaim: normalizeConfirmation(game.fallbackClaim),
    terminal: game.terminal ?? null,
  });
}

function normalizeParticipants(participants) {
  if (!participants || typeof participants !== 'object' || Array.isArray(participants)) {
    throw new ProtocolError('INVALID_GAME_STATE', 'Participants are required');
  }
  const normalized = {};
  for (const [player, details] of Object.entries(participants)) {
    if (!details || typeof details.scriptPublicKey !== 'string' || details.scriptPublicKey.length === 0) {
      throw new ProtocolError('INVALID_GAME_STATE', `Participant ${player} scriptPublicKey is required`);
    }
    normalized[player] = { scriptPublicKey: details.scriptPublicKey };
  }
  if (Object.keys(normalized).length !== 2) {
    throw new ProtocolError('INVALID_GAME_STATE', 'Exactly two participants are required');
  }
  return normalized;
}

function normalizeReveal(reveal, players) {
  if (reveal === undefined || reveal === null) return null;
  if (!players.includes(reveal.player)) throw new ProtocolError('INVALID_GAME_STATE', 'Reveal player must be a participant');
  const normalized = normalizeConfirmation(reveal);
  normalized.player = reveal.player;
  if (reveal.fallbackDeadlineDaa !== undefined) {
    normalized.fallbackDeadlineDaa = normalizeDaa(reveal.fallbackDeadlineDaa, 'fallback deadline DAA score');
  }
  return normalized;
}

function normalizeConfirmation(value) {
  if (value === undefined || value === null) return null;
  return {
    confirmedDaaScore: normalizeDaa(value.confirmedDaaScore, 'confirmed DAA score'),
    transactionId: value.transactionId,
  };
}

function winsBeforeOrAt(left, right) {
  return left && (!right || left.confirmedDaaScore <= right.confirmedDaaScore);
}

function decision(status, available, message, extra = {}) {
  return Object.freeze({ status, available, message, ...extra });
}

function parseTransaction(transaction) {
  const parsed = typeof transaction === 'string' ? JSON.parse(transaction) : transaction;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.inputs) || !Array.isArray(parsed.outputs)) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Transaction template must include inputs and outputs');
  }
  return parsed;
}

function assertSinglePayout(transaction, value, scriptPublicKey, name) {
  const payouts = transaction.outputs.filter((output) => BigInt(output?.value ?? -1) === value && output?.scriptPublicKey === scriptPublicKey);
  if (payouts.length !== 1) {
    throw new ProtocolError('INVALID_TRANSACTION', `Transaction must contain exactly one ${name}`);
  }
}

function assertGameFeeOutput(transaction, value) {
  if (value === 0n) return;
  const fees = transaction.outputs.filter((output) => BigInt(output?.value ?? -1) === value && !output?.covenant);
  if (fees.length !== 1) {
    throw new ProtocolError('INVALID_TRANSACTION', 'Transaction must contain exactly one game fee output');
  }
}

function assertFeeSeparated(transaction) {
  const totalIn = transaction.inputs.reduce((sum, input) => sum + normalizePositiveBigInt(input?.utxo?.amount, 'input amount'), 0n);
  const totalOut = transaction.outputs.reduce((sum, output) => sum + normalizePositiveBigInt(output?.value, 'output value'), 0n);
  if (totalIn < totalOut) throw new ProtocolError('FEE_SUBSTITUTION', 'Payout value cannot fund fees');
}

function normalizePositiveBigInt(value, name) {
  if (typeof value === 'bigint' && value > 0n) return value;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) > 0n) return BigInt(value);
  throw new ProtocolError('INVALID_GAME_STATE', `${name} must be a positive integer`);
}

function normalizeDaa(value, name) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new ProtocolError('INVALID_GAME_STATE', `${name} must be a non-negative integer`);
}
