import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAvailableActions, deriveGameStatus } from '../src/game-projection.js';

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
