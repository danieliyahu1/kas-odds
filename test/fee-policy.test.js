import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeBudgetMass, estimateCreationFee, selectOrdinaryUtxos } from '../src/fee-policy.js';

const MIN_STAKE = 1n * 1_0000_0000n;
const ord = (txid, index, amount) => ({ transactionId: txid, index, amount });

test('adds the consensus v1 compute-budget mass the WASM calculator omits', () => {
  assert.equal(computeBudgetMass([{ computeBudget: 50 }, { computeBudget: 50 }]), 10_000);
  assert.equal(computeBudgetMass([{ computeBudget: 50 }, { computeBudget: 50 }, { computeBudget: 50 }]), 15_000);
  assert.equal(computeBudgetMass([{ computeBudget: 0 }]), 0);
  assert.equal(computeBudgetMass([]), 0);
  assert.equal(computeBudgetMass(undefined), 0);
});

test('selects ordinary UTXOs deterministic largest-first to meet the target', () => {
  const utxos = [
    ord('a1'.repeat(32), 0, 50n),
    ord('b2'.repeat(32), 0, 200n),
    ord('c3'.repeat(32), 0, 100n),
    ord('d4'.repeat(32), 0, 200n),
  ];
  const { selected, totalSompi } = selectOrdinaryUtxos({ utxos, targetSompi: 350n });
  assert.deepEqual(selected, [
    { transactionId: 'b2'.repeat(32), index: 0, amount: 200n },
    { transactionId: 'd4'.repeat(32), index: 0, amount: 200n },
  ]);
  assert.equal(totalSompi, 400n);
});

test('breaks ties deterministically by outpoint', () => {
  const utxos = [
    ord('a1'.repeat(32), 0, 100n),
    ord('b2'.repeat(32), 0, 100n),
  ];
  const { selected } = selectOrdinaryUtxos({ utxos, targetSompi: 100n });
  assert.deepEqual(selected, [{ transactionId: 'a1'.repeat(32), index: 0, amount: 100n }]);
});

test('excludes covenant UTXOs and explicit outpoints from fee funding', () => {
  const covenant = { transactionId: 'e5'.repeat(32), index: 0, amount: 999n, covenantId: '11'.repeat(32) };
  const exclude = [ord('f6'.repeat(32), 0, 200n)];
  const utxos = [covenant, ord('f6'.repeat(32), 0, 200n), ord('a1'.repeat(32), 0, 250n)];
  const { selected } = selectOrdinaryUtxos({ utxos, targetSompi: 250n, exclude });
  assert.deepEqual(selected, [{ transactionId: 'a1'.repeat(32), index: 0, amount: 250n }]);
});

test('rejects empty or insufficient funds', () => {
  assert.throws(() => selectOrdinaryUtxos({ utxos: [], targetSompi: 1n }), { code: 'NO_UTXOS' });
  assert.throws(() => selectOrdinaryUtxos({ utxos: [ord('a1'.repeat(32), 0, 100n)], targetSompi: 150n }), { code: 'INSUFFICIENT_UTXOS' });
  assert.throws(() => selectOrdinaryUtxos({ utxos: [{ transactionId: 'a1'.repeat(32), index: 0, amount: 100n, covenantId: '11'.repeat(32) }], targetSompi: 50n }), { code: 'NO_ORDINARY_UTXOS' });
});

test('estimates fee from live priority feerate', () => {
  const estimate = estimateCreationFee({ mass: 10_000, priorityFeerate: 0.5, options: { relayFloorRate: 0 } });
  assert.equal(estimate.feeSompi, 5_000n);
});

test('applies the local relay-mass floor when the live rate is idle', () => {
  const estimate = estimateCreationFee({ mass: 10_000, priorityFeerate: 0, options: { relayFloorRate: 0.5 } });
  assert.equal(estimate.feeSompi, 5_000n);
});

test('never lets the fee drop below the configured minimum', () => {
  const estimate = estimateCreationFee({ mass: 100, priorityFeerate: 0, options: { minFeeSompi: 1_000n, relayFloorRate: 0 } });
  assert.equal(estimate.feeSompi, 1_000n);
});

test('rejects malformed mass and feerate', () => {
  assert.throws(() => estimateCreationFee({ mass: 0, priorityFeerate: 1 }), { code: 'INVALID_MASS' });
  assert.throws(() => estimateCreationFee({ mass: 1.5, priorityFeerate: 1 }), { code: 'INVALID_MASS' });
  assert.throws(() => estimateCreationFee({ mass: 100, priorityFeerate: -1 }), { code: 'INVALID_FEE_ESTIMATE' });
});
