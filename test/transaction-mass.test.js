import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCreateGame } from '../src/create-game.js';
import { playerLockSompi } from '../src/protocol.js';
import { createWasmGenesisSafeJson } from '../src/wasm-transaction.js';
import { assertSignedTransactionFee, estimateSignedTransactionMass, signedTransactionFeeDiagnostics } from '../src/transaction-mass.js';

const NETWORK = 'testnet-10';
const request = prepareCreateGame({
  network: NETWORK,
  creatorAddress: 'kaspatest:creator',
  creatorPublicKey: '07'.repeat(32),
  creatorCommitment: '09'.repeat(32),
  deadlineDaa: 500000000000n,
  side: 'even',
  stakeKas: 49,
  feeSompi: 0n,
  gameFeePublicKey: '11'.repeat(32),
});

function preparedCreation() {
  return createWasmGenesisSafeJson({
    request,
    authorizingInput: 0,
    inputs: [{
      transactionId: '11'.repeat(32),
      index: 2,
      amount: playerLockSompi(request.stakeSompi) + 400_000_000n,
      scriptPublicKey: '000051',
      blockDaaScore: 1n,
      isCoinbase: false,
    }],
  });
}

function sign(txJson) {
  const signed = JSON.parse(txJson);
  signed.inputs[0].signatureScript = `41${'ab'.repeat(65)}`;
  return signed;
}

test('creation fee includes the KasWare signature before the wallet signs', () => {
  const prepared = preparedCreation();
  const unsigned = JSON.parse(prepared.txJson);
  const signed = sign(prepared.txJson);
  const estimate = estimateSignedTransactionMass(NETWORK, unsigned);
  const actual = signedTransactionFeeDiagnostics({ network: NETWORK, signedTxJson: signed });

  assert.equal(estimate.assumedSignedInputs, 1);
  assert.equal(prepared.assumedSignedInputs, 1);
  assert.equal(prepared.mass, actual.mass);
  assert.equal(estimate.mass, actual.mass);
  assert.ok(actual.paidFeeSompi >= actual.requiredFeeSompi);
});

test('signed fee guard rejects a transaction that cannot pay its actual mass', () => {
  const prepared = preparedCreation();
  const signed = sign(prepared.txJson);
  signed.outputs[1].value = String(BigInt(signed.outputs[1].value) + 1n);

  assert.throws(
    () => assertSignedTransactionFee({ network: NETWORK, signedTxJson: signed }),
    (error) => error.code === 'INSUFFICIENT_TRANSACTION_FEE'
      && error.transactionDiagnostics.paidFeeSompi < error.transactionDiagnostics.requiredFeeSompi,
  );
});
