import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestRequestGate, createPollController, isTerminalGameStatus } from '../public/app-controller.js';

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
