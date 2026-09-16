import test from 'node:test';
import assert from 'node:assert/strict';
import { actionErrorCopy, createLatestRequestGate, createPollController, isTerminalGameStatus, MATCH_GAME_WAIT, MATCH_VIEW, matchGameWaitState, resolveMatchView, shouldRerenderMatch } from '../public/app-controller.js';

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
  assert.equal(actionErrorCopy({ code: 'SOMETHING_NEW' }).title, 'Please try again');
  assert.equal(actionErrorCopy(undefined).title, 'Please try again');
});
