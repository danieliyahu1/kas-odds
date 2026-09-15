import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTransactionIntent } from '../src/transaction-intent.js';

const covenantInput = {
  transactionId: 'aa'.repeat(32),
  index: 0,
  sequence: '3000',
  signatureScript: '01aa',
  utxo: {
    amount: '200000000',
    scriptPublicKey: '0000covenant',
    covenantId: 'bb'.repeat(32),
  },
};
const walletInput = {
  transactionId: 'cc'.repeat(32),
  index: 1,
  sequence: '0',
  signatureScript: '',
  utxo: { amount: '1000000', scriptPublicKey: '000051' },
};

function transaction(overrides = {}) {
  return {
    inputs: [structuredClone(covenantInput), structuredClone(walletInput)],
    outputs: [{ value: '199000000', scriptPublicKey: '000051', covenant: null }, { value: '1000000', scriptPublicKey: '000052', covenant: null }],
    lockTime: '0',
    ...overrides,
  };
}

const intent = {
  covenantInput: { transactionId: covenantInput.transactionId, index: 0, amount: '200000000', scriptPublicKey: covenantInput.utxo.scriptPublicKey, covenantId: covenantInput.utxo.covenantId, signatureScript: '01aa' },
  sequence: '3000',
  fixedOutputs: [{ value: '199000000', scriptPublicKey: '000051', covenant: null }],
  feeSompi: '1000000',
  changeScriptPublicKey: '000052',
};

test('verifies complete terminal intent and returns wallet signing indexes', () => {
  const result = verifyTransactionIntent({ action: 'reveal', txJson: JSON.stringify(transaction()), intent });
  assert.deepEqual(result.signInputs, [{ index: 1, sighashType: 1 }]);
});

test('rejects payout mutation, fee substitution, and unexpected outputs', () => {
  const payout = transaction();
  payout.outputs[0].value = '198999999';
  assert.throws(() => verifyTransactionIntent({ action: 'reveal', txJson: JSON.stringify(payout), intent }), { code: 'SIGNED_TRANSACTION_MISMATCH' });

  const fee = transaction();
  fee.outputs[1].value = '1000001';
  assert.throws(() => verifyTransactionIntent({ action: 'reveal', txJson: JSON.stringify(fee), intent }), { code: 'SIGNED_TRANSACTION_MISMATCH' });

  const extra = transaction();
  extra.outputs.splice(1, 0, { value: '1', scriptPublicKey: '000053', covenant: null });
  assert.throws(() => verifyTransactionIntent({ action: 'reveal', txJson: JSON.stringify(extra), intent }), { code: 'SIGNED_TRANSACTION_MISMATCH' });
});

test('rejects covenant invocation and funding-input mutations', () => {
  const covenant = transaction();
  covenant.inputs[0].signatureScript = '01bb';
  assert.throws(() => verifyTransactionIntent({ action: 'reveal', txJson: JSON.stringify(covenant), intent }), { code: 'SIGNED_TRANSACTION_MISMATCH' });

  const funding = transaction();
  funding.inputs[1].signatureScript = '01aa';
  assert.throws(() => verifyTransactionIntent({ action: 'reveal', txJson: JSON.stringify(funding), intent }), { code: 'SIGNED_TRANSACTION_MISMATCH' });
});
