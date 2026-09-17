import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAvailableActions, deriveGameStatus, projectTerminalTransactions } from '../src/game-projection.js';

test('derives lifecycle status from confirmed and pending game events', () => {
  const base = { status: 'joined', join: { transactionId: 'join' }, automaticSettlement: null };
  assert.equal(deriveGameStatus({ record: base, confirmation: { status: 'confirmed' }, confirmedReveals: [], pendingReveals: [], pendingSafety: [], safetyStatus: false, automaticBroadcast: false }), 'joined');
  assert.equal(deriveGameStatus({ record: base, confirmation: { status: 'observed' }, confirmedReveals: [], pendingReveals: [{ winner: false }], pendingSafety: [], safetyStatus: false, automaticBroadcast: false }), 'reveal_broadcast');
  assert.equal(deriveGameStatus({ record: base, confirmation: { status: 'confirmed' }, confirmedReveals: [{ winner: true }], pendingReveals: [], pendingSafety: [], safetyStatus: false, automaticBroadcast: false }), 'settled');
});

test('derives only actions permitted by the projected status', () => {
  assert.deepEqual(deriveAvailableActions({ status: 'waiting_for_player_b', firstRevealer: null }), {
    safetyAction: 'creator_refund', automaticAction: 'refund_open', canReveal: false, canCancel: true, firstRevealer: null,
  });
  assert.deepEqual(deriveAvailableActions({ status: 'first_revealed', firstRevealer: 'kaspatest:creator' }), {
    safetyAction: null, automaticAction: 'fallback_claim', canReveal: true, canCancel: false, firstRevealer: 'kaspatest:creator',
  });
});

test('exposes the on-chain transactions of a finished game, only when terminal', () => {
  const record = {
    safetyActions: [{ action: 'fallback_claim', transactionId: 'claim-tx' }],
    automaticSettlement: { action: 'refund_open', transactionId: 'automatic-tx' },
  };
  const confirmedReveals = [{ role: 'joiner', winner: true, transactionId: 'settlement-tx' }];

  assert.deepEqual(projectTerminalTransactions({ record, confirmedReveals, status: 'joined' }), []);
  assert.deepEqual(projectTerminalTransactions({ record, confirmedReveals, status: 'settled' }), [
    { action: 'settlement', transactionId: 'settlement-tx' },
    { action: 'fallback_claim', transactionId: 'claim-tx' },
    { action: 'refund_open', transactionId: 'automatic-tx' },
  ]);
});

test('lists each on-chain transaction once', () => {
  const record = { safetyActions: [{ action: 'refund', transactionId: 'same-tx' }], automaticSettlement: { action: 'refund_all', transactionId: 'same-tx' } };
  assert.deepEqual(projectTerminalTransactions({ record, confirmedReveals: [], status: 'refunded' }), [
    { action: 'refund', transactionId: 'same-tx' },
  ]);
});
