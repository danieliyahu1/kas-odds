import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deadlineAfterDaa,
  FALLBACK_CLAIM_DAA_OFFSET,
  NO_REVEAL_REFUND_DAA_OFFSET,
  resolveFallbackClaim,
  resolveIndividualRefund,
  safetyReadiness,
  TERMINAL_COPY,
  terminalActionView,
  validateFallbackClaimTemplate,
  validateIndividualRefundTemplate,
} from '../src/terminal-actions.js';

const game = {
  stakeSompi: 100_000_000n,
  potSompi: 200_000_000n,
  joinedDaaScore: 1_000n,
  participants: {
    creator: { scriptPublicKey: '000051' },
    joiner: { scriptPublicKey: '000052' },
  },
};

test('pins five-minute testnet-10 DAA deadlines', () => {
  assert.equal(FALLBACK_CLAIM_DAA_OFFSET, 3_000n);
  assert.equal(NO_REVEAL_REFUND_DAA_OFFSET, 3_000n);
  assert.equal(deadlineAfterDaa(10n), 3_010n);
});

test('reports refund readiness from DAA scores', () => {
  assert.deepEqual(safetyReadiness(1_000n, 4_000n), { ready: false, remainingSeconds: 300 });
  assert.deepEqual(safetyReadiness(3_999n, 4_000n), { ready: false, remainingSeconds: 1 });
  assert.deepEqual(safetyReadiness(4_000n, 4_000n), { ready: true, remainingSeconds: 0 });
  assert.deepEqual(safetyReadiness(5_000n, 4_000n), { ready: true, remainingSeconds: 0 });
});

test('fallback claim is unavailable until first reveal plus fallback deadline', () => {
  const firstReveal = { player: 'creator', confirmedDaaScore: 2_000n };
  assert.deepEqual(resolveFallbackClaim({ game: { ...game, firstReveal }, caller: 'creator', currentDaaScore: 4_999n }), {
    status: 'unavailable',
    available: false,
    message: TERMINAL_COPY.fallbackUnavailable,
    availableDaaScore: 5_000n,
  });
  assert.deepEqual(resolveFallbackClaim({ game: { ...game, firstReveal }, caller: 'creator', currentDaaScore: 5_000n }), {
    status: 'available',
    available: true,
    message: 'Fallback claim is available.',
    action: 'fallback_claim',
    player: 'creator',
  });
});

test('second reveal settles normally if confirmed before fallback claim', () => {
  const result = resolveFallbackClaim({
    game: {
      ...game,
      firstReveal: { player: 'creator', confirmedDaaScore: 2_000n },
      secondReveal: { player: 'joiner', confirmedDaaScore: 5_050n },
      fallbackClaim: { confirmedDaaScore: 5_100n },
    },
    caller: 'creator',
    currentDaaScore: 5_200n,
  });
  assert.equal(result.status, 'already_complete');
  assert.equal(result.message, TERMINAL_COPY.settledBySecondReveal);
});

test('confirmed fallback claim defeats later reveals', () => {
  const result = resolveFallbackClaim({
    game: {
      ...game,
      firstReveal: { player: 'creator', confirmedDaaScore: 2_000n },
      fallbackClaim: { confirmedDaaScore: 5_010n },
      secondReveal: { player: 'joiner', confirmedDaaScore: 5_100n },
    },
    caller: 'creator',
    currentDaaScore: 5_200n,
  });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.message, TERMINAL_COPY.fallbackConfirmed);
});

test('refund is available only after no-reveal deadline and only to participants', () => {
  assert.equal(resolveIndividualRefund({ game, caller: 'observer', currentDaaScore: 4_000n }).message, TERMINAL_COPY.refundNotPlayer);
  assert.equal(resolveIndividualRefund({ game, caller: 'creator', currentDaaScore: 3_999n }).available, false);
  assert.deepEqual(resolveIndividualRefund({ game, caller: 'creator', currentDaaScore: 4_000n }), {
    status: 'available',
    available: true,
    message: 'Refund is available.',
    action: 'individual_refund',
    player: 'creator',
  });
});

test('refund is refused after any valid reveal and reports completed own refund', () => {
  assert.equal(
    resolveIndividualRefund({ game: { ...game, firstReveal: { player: 'joiner', confirmedDaaScore: 2_000n } }, caller: 'creator', currentDaaScore: 4_000n }).message,
    TERMINAL_COPY.refundRevealExists,
  );
  assert.equal(
    resolveIndividualRefund({ game: { ...game, refunds: { creator: true } }, caller: 'creator', currentDaaScore: 4_000n }).message,
    TERMINAL_COPY.refundAlreadyComplete,
  );
});

test('validates a no-fee fallback claim and fee separation', () => {
  const tx = templateTx({
    inputAmount: 200_010_000n,
    outputValue: 200_000_000n,
    scriptPublicKey: '000051',
    extraOutputs: [],
  });
  assert.equal(validateFallbackClaimTemplate({
    game: { ...game, firstReveal: { player: 'creator', confirmedDaaScore: 2_000n } },
    caller: 'creator',
    currentDaaScore: 5_000n,
    transaction: tx,
  }), tx);

  assert.throws(() => validateFallbackClaimTemplate({
    game: { ...game, firstReveal: { player: 'creator', confirmedDaaScore: 2_000n } },
    caller: 'creator',
    currentDaaScore: 5_000n,
    transaction: templateTx({
       inputAmount: 199_999_999n,
       outputValue: 200_000_000n,
      scriptPublicKey: '000051',
       extraOutputs: [],
    }),
  }), { code: 'FEE_SUBSTITUTION' });
});

test('validates individual refund pays only caller escrow', () => {
  const tx = templateTx({
    inputAmount: 200_010_000n,
    outputValue: 100_000_000n,
    scriptPublicKey: '000052',
    extraOutputs: [{ value: '100000000', scriptPublicKey: '0000aa20' + '00'.repeat(32) + '87', covenant: { authorizingInput: 0, covenantId: '33'.repeat(32) } }],
  });
  assert.equal(validateIndividualRefundTemplate({ game, caller: 'joiner', currentDaaScore: 4_000n, transaction: tx }), tx);
  assert.throws(() => validateIndividualRefundTemplate({
    game,
    caller: 'joiner',
    currentDaaScore: 4_000n,
    transaction: templateTx({ inputAmount: 200_010_000n, outputValue: 100_000_000n, scriptPublicKey: '000052', extraOutputs: [{ value: '100000000', scriptPublicKey: '000051' }] }),
  }), { code: 'INVALID_TRANSACTION' });
  assert.throws(() => validateIndividualRefundTemplate({
    game,
    caller: 'joiner',
    currentDaaScore: 4_000n,
    transaction: templateTx({ inputAmount: 200_000_000n, outputValue: 200_000_000n, scriptPublicKey: '000052' }),
  }), { code: 'INVALID_TRANSACTION' });
});

test('projects terminal decisions into browser action states', () => {
  assert.deepEqual(terminalActionView('fallback_claim', resolveFallbackClaim({ game, caller: 'creator', currentDaaScore: 1_000n })), {
    action: 'fallback_claim',
    state: 'unavailable',
    canSubmit: false,
    message: TERMINAL_COPY.fallbackUnavailable,
    availableDaaScore: undefined,
  });
  assert.deepEqual(terminalActionView('individual_refund', resolveIndividualRefund({ game, caller: 'creator', currentDaaScore: 4_000n })), {
    action: 'individual_refund',
    state: 'available',
    canSubmit: true,
    message: 'Refund is available.',
    availableDaaScore: undefined,
  });
});

function templateTx({ inputAmount, outputValue, scriptPublicKey, extraOutputs = [] }) {
  return {
    inputs: [{ utxo: { amount: String(inputAmount) } }],
    outputs: [{ value: String(outputValue), scriptPublicKey }, ...extraOutputs],
  };
}
