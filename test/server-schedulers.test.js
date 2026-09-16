import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerSchedulers } from '../src/server-schedulers.js';

test('the scheduler reconciles pending submissions on start', async () => {
  let reconciled = 0;
  let telemetry = 0;
  let pruned = 0;
  const gameService = {
    settleAutomaticGames: async () => 0,
    automaticSettlementDelayMs: async () => null,
    refreshTelemetry: async () => { telemetry += 1; },
    pruneCompletedGames: async () => { pruned += 1; return 0; },
    reconcilePendingSubmissions: async () => { reconciled += 1; return 0; },
  };
  const schedulers = createServerSchedulers({
    gameService,
    feedbackService: { drainPending: async () => {} },
    feedbackDeliverer: { enabled: false },
    chainClient: { connect: async () => {} },
    logger: { debug() {}, warn() {}, info() {}, error() {} },
  });

  await schedulers.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  schedulers.stop();

  assert.ok(reconciled >= 1, 'a crash window must be reconciled on startup and on the timer');
  assert.ok(telemetry >= 1);
  assert.ok(pruned >= 1, 'finished games must be pruned on startup and on the timer');
});
