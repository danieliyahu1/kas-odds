import test from 'node:test';
import assert from 'node:assert/strict';
import { actionErrorCopy, covenantClock, createLatestRequestGate, createPollController, formatWait, GAME_STAGE, gameSignature, gameStage, isTerminalGameStatus, lobbyStage, MATCH_GAME_WAIT, MATCH_VIEW, matchGameWaitState, resolveMatchView, shouldRerenderMatch, terminalNotice } from '../public/app-controller.js';

test('latest request gate rejects responses from older requests', () => {
  const gate = createLatestRequestGate();
  const first = gate.next();
  const second = gate.next();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
});

test('poll controller cancels the previous generation and prevents overlap', async () => {
  const timers = [];
  const cleared = [];
  let resolvePoll;
  let calls = 0;
  const controller = createPollController({
    intervalMs: 10,
    setIntervalFn: (callback) => { timers.push(callback); return timers.length; },
    clearIntervalFn: (timer) => cleared.push(timer),
    onPoll: async () => { calls += 1; await new Promise((resolve) => { resolvePoll = resolve; }); },
  });
  controller.start('first');
  await Promise.resolve();
  timers[0]();
  assert.equal(calls, 1);
  controller.start('second');
  assert.deepEqual(cleared, [1]);
  resolvePoll();
  await Promise.resolve();
  assert.equal(controller.active, true);
});

test('poll controller can start without an immediate tick', async () => {
  const timers = [];
  let calls = 0;
  const controller = createPollController({
    intervalMs: 10,
    setIntervalFn: (callback) => { timers.push(callback); return timers.length; },
    clearIntervalFn: () => {},
    onPoll: async () => { calls += 1; },
  });
  controller.start('game', { immediate: false });
  assert.equal(calls, 0, 'no tick fires before the first interval elapses');
  timers[0]();
  await Promise.resolve();
  assert.equal(calls, 1);
});

test('terminal statuses are explicit', () => {
  assert.equal(isTerminalGameStatus('settled'), true);
  assert.equal(isTerminalGameStatus('joined'), false);
});

const matched = (overrides = {}) => ({ status: 'matched', opponentConnected: true, role: 'joiner', gameId: null, side: 'even', stakeKas: 6, ...overrides });

test('match view finds a rival, plays for both roles, and reopens a published game', () => {
  assert.equal(resolveMatchView({ status: 'waiting' }), MATCH_VIEW.FINDING);
  assert.equal(resolveMatchView(matched({ role: 'joiner', gameId: null })), MATCH_VIEW.PLAY);
  assert.equal(resolveMatchView(matched({ role: 'creator', gameId: null })), MATCH_VIEW.PLAY);
  assert.equal(resolveMatchView(matched({ role: 'joiner', gameId: 'a'.repeat(64) })), MATCH_VIEW.PLAY);
  assert.equal(resolveMatchView(matched({ role: 'creator', gameId: 'a'.repeat(64) })), MATCH_VIEW.REOPEN);
  assert.equal(resolveMatchView({ status: 'cancelled' }), MATCH_VIEW.ABANDONED);
  assert.equal(resolveMatchView(matched({ opponentConnected: false })), MATCH_VIEW.ABANDONED);
  assert.throws(() => resolveMatchView(null), /state is required/);
});

test('rerender keeps the joiner selection while picking but honors abandonment', () => {
  const previous = matched();
  const withGame = matched({ gameId: 'b'.repeat(64) });
  assert.equal(shouldRerenderMatch(undefined, previous), true);
  assert.equal(shouldRerenderMatch(previous, withGame, { picking: true }), false);
  assert.equal(shouldRerenderMatch(previous, withGame, { picking: false }), true);
  assert.equal(shouldRerenderMatch(previous, matched({ status: 'cancelled' }), { picking: true }), true);
  assert.equal(shouldRerenderMatch(previous, matched({ opponentConnected: false }), { picking: true }), true);
  assert.equal(shouldRerenderMatch(previous, { ...previous }, { picking: false }), false);
});

test('game wait resolves to ready, cancelled, timeout, or pending', () => {
  assert.equal(matchGameWaitState(matched({ gameId: 'c'.repeat(64) })), MATCH_GAME_WAIT.READY);
  assert.equal(matchGameWaitState(matched({ status: 'cancelled' })), MATCH_GAME_WAIT.CANCELLED);
  assert.equal(matchGameWaitState(matched({ opponentConnected: false })), MATCH_GAME_WAIT.CANCELLED);
  assert.equal(matchGameWaitState(null), MATCH_GAME_WAIT.CANCELLED);
  assert.equal(matchGameWaitState(matched(), { elapsedMs: 60_000, timeoutMs: 60_000 }), MATCH_GAME_WAIT.TIMEOUT);
  assert.equal(matchGameWaitState(matched(), { elapsedMs: 1_000, timeoutMs: 60_000 }), MATCH_GAME_WAIT.PENDING);
});

test('action error copy maps known codes and falls back for anything unknown', () => {
  assert.deepEqual(actionErrorCopy({ code: 'NO_UTXOS' }), { title: 'Network fee unavailable', message: 'This wallet needs a small separate balance to pay the network fee.' });
  assert.deepEqual(actionErrorCopy({ code: 'MATCH_TIMEOUT' }), { title: 'Still waiting for your opponent', message: 'They did not create the game in time. Try again in a moment.' });
  assert.deepEqual(actionErrorCopy({ code: 'GAME_CANCELLED' }), { title: 'The game was canceled', message: 'Find another player to play against. No KAS was locked.' });
  assert.equal(actionErrorCopy({ code: 'SOMETHING_NEW' }).title, 'Please try again');
  assert.equal(actionErrorCopy(undefined).title, 'Please try again');
});

test('the rail begins at the match, not while waiting for an opponent', () => {
  assert.equal(lobbyStage({ phase: 'waiting', mode: 'public', match: {} }), null);
  assert.equal(lobbyStage({ phase: 'waiting', mode: 'host', match: {} }), null);
  assert.equal(lobbyStage({ phase: 'guest-entry', mode: 'guest', match: null }), null);
  assert.equal(lobbyStage({ phase: 'limit', mode: 'public', match: null }), null);
  assert.equal(lobbyStage({ phase: 'abandoned', mode: 'public', match: matched() }), null);
});

test('the lobby names the stage the player is on once matched', () => {
  assert.equal(lobbyStage({ phase: 'pick', mode: 'public', match: matched() }).title, 'Your turn to vote');
  assert.equal(lobbyStage({ phase: 'wallet', mode: 'host', match: matched() }).title, 'Locking your number');
  assert.equal(lobbyStage({ phase: 'preparing', mode: 'host', match: matched() }).title, 'Locking your number');
});

test('after Play both roles share one lock and neither is parked on the other', () => {
  const stage = (match) => lobbyStage({ phase: 'preparing', mode: 'public', match });
  assert.equal(stage(matched({ role: 'creator', gameId: null })).stage, GAME_STAGE.LOCKING);
  assert.equal(stage(matched({ role: 'joiner', gameId: null })).stage, GAME_STAGE.LOCKING);
  assert.equal(stage(matched({ role: 'joiner', gameId: null })).title, stage(matched({ role: 'creator', gameId: null })).title);
  assert.equal(stage(matched({ role: 'joiner', gameId: 'a'.repeat(64) })).title, 'Locking your number');
});

test('the rail shows the two moves and never a wait', () => {
  const voting = lobbyStage({ phase: 'pick', mode: 'public', match: matched() }).rail;
  assert.deepEqual(voting.map((node) => [node.label, node.state]), [['Vote', 'current'], ['Reveal', 'ahead']]);
  const waiting = lobbyStage({ phase: 'preparing', mode: 'public', match: matched({ role: 'joiner', gameId: null }) }).rail;
  assert.deepEqual(waiting.map((node) => node.state), ['current', 'ahead']);
  const revealing = gameStage({ matchmaking: true, status: 'joined', canReveal: true }, 'creator').rail;
  assert.deepEqual(revealing.map((node) => [node.label, node.state]), [['Vote', 'done'], ['Reveal', 'current']]);
});

test('the game page names the stage and whose move it is', () => {
  assert.equal(gameStage({ matchmaking: true, status: 'waiting_for_player_b' }, 'creator').title, 'Waiting for the other person to vote');
  assert.equal(gameStage({ matchmaking: false, status: 'waiting_for_player_b' }, 'creator').title, 'Waiting for your friend to vote');
  assert.equal(gameStage({ matchmaking: false, status: 'joined', canReveal: true }, 'joiner').title, 'Your turn to reveal');
  const revealed = { matchmaking: false, status: 'first_revealed', canReveal: true, revealedPicks: { creator: 1 } };
  assert.equal(gameStage(revealed, 'creator').title, 'Revealing...');
  assert.equal(gameStage(revealed, 'joiner').title, 'Your turn to reveal');
  assert.equal(gameStage({ matchmaking: true, status: 'reveal_broadcast', pendingReveals: [{ role: 'joiner' }] }, 'joiner').title, 'Revealing...');
  assert.equal(gameStage({ matchmaking: true, status: 'reveal_broadcast', pendingReveals: [{ role: 'joiner' }] }, 'creator').title, 'Your turn to reveal');
  assert.equal(gameStage({ matchmaking: true, status: 'waiting_for_player_b' }, 'creator').loading, true);
  assert.equal(gameStage({ matchmaking: false, status: 'joined', canReveal: true }, 'creator').loading, false);
});

test('a finished game and a viewer get no rail', () => {
  assert.equal(gameStage({ status: 'settled' }, 'creator'), null);
  assert.equal(gameStage({ status: 'refunded' }, 'creator'), null);
  assert.equal(gameStage({ status: 'joined', canReveal: true }, 'viewer'), null);
});

test('terminal copy is shared for refunds and per person for a fallback claim', () => {
  const ref = { matchmaking: true, status: 'refunded' };
  assert.deepEqual(terminalNotice(ref, 'creator'), terminalNotice(ref, 'joiner'));
  assert.equal(terminalNotice(ref, 'viewer').message, 'The stake was returned.');
  assert.equal(terminalNotice({ matchmaking: true, status: 'refund_partial' }, 'creator').message, terminalNotice({ matchmaking: true, status: 'refund_partial' }, 'joiner').message);
  assert.equal(terminalNotice({ matchmaking: true, status: 'settled' }, 'creator'), null);
  const claim = { matchmaking: true, status: 'fallback_claimed', firstRevealer: 'kaspatest:creator', creator: { address: 'kaspatest:creator' }, joiner: { address: 'kaspatest:joiner' } };
  assert.equal(terminalNotice(claim, 'creator').message, 'Your opponent never revealed, so you took the pot.');
  assert.equal(terminalNotice(claim, 'joiner').message, 'You never revealed, so your opponent took the pot.');
  assert.notEqual(terminalNotice(claim, 'creator').message, terminalNotice(claim, 'joiner').message);
  assert.equal(terminalNotice(claim, 'viewer').message, 'The first revealer took the pot.');
});

test('formatWait renders the clock as m:ss', () => {
  assert.equal(formatWait(272), '4:32');
  assert.equal(formatWait(300), '5:00');
  assert.equal(formatWait(5), '0:05');
  assert.equal(formatWait(0), '0:00');
  assert.equal(formatWait(-3), '0:00');
  assert.equal(formatWait(undefined), '0:00');
});

test('the repaint signature tracks the readiness flip, not the ticking seconds', () => {
  const base = { status: 'joined', safetyAction: null, safetyReady: null, automaticAction: 'refund_all', automaticReady: false, automaticRemainingSeconds: 300, firstRevealer: null, winner: undefined };
  assert.notEqual(gameSignature({ ...base, automaticReady: true }), gameSignature(base));
  assert.equal(gameSignature({ ...base, automaticRemainingSeconds: 299 }), gameSignature(base));
});

test('the repaint signature tracks the chain readiness flip so the button appears on advance', () => {
  const base = { status: 'first_revealed', chainReady: false, firstRevealer: 'kaspatest:creator', winner: undefined };
  assert.notEqual(gameSignature({ ...base, chainReady: true }), gameSignature(base));
});

test('the covenant clock names the entry and explains the rule that phase enforces', () => {
  const game = (overrides = {}) => ({ automaticAction: 'refund_all', automaticReady: false, automaticRemainingSeconds: 300, ...overrides });
  assert.equal(covenantClock(game()).label, 'Refund');
  assert.match(covenantClock(game()).note, /contract returns both stakes/);
  assert.match(covenantClock(game({ automaticAction: 'refund_open' })).note, /join deadline passes/);
  assert.match(covenantClock(game({ automaticAction: 'fallback_claim' }), { isFirstRevealer: true }).note, /first revealer/);
});

test('the claim clock is hidden from everyone but the first revealer', () => {
  const claim = { automaticAction: 'fallback_claim', automaticReady: false, automaticRemainingSeconds: 120 };
  assert.equal(covenantClock(claim, { isFirstRevealer: false }), null);
  assert.equal(covenantClock(claim, { isFirstRevealer: true }).label, 'Claim');
});

test('a ready covenant clock reports zero remaining, and no entry means no clock', () => {
  const ready = covenantClock({ automaticAction: 'refund_open', automaticReady: true, automaticRemainingSeconds: 7 });
  assert.equal(ready.ready, true);
  assert.equal(ready.remainingSeconds, 0);
  assert.equal(covenantClock({ automaticAction: null }), null);
});
