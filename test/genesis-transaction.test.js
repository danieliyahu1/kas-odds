import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCreateGame } from '../src/create-game.js';
import { playerLockSompi } from '../src/protocol.js';
import {
  computeGenesisCovenantId,
  createGenesisGameOutput,
  validateCreationTransaction,
  verifySignedCreationSafeJson,
} from '../src/genesis-transaction.js';

const request = prepareCreateGame({
  network: 'testnet-10',
  creatorAddress: 'kaspatest:creator',
  creatorPublicKey: '07'.repeat(32),
  creatorCommitment: '09'.repeat(32),
  deadlineDaa: 500000000000n,
  side: 'even',
  stakeKas: 1,
  feeSompi: 1000n,
  gameFeePublicKey: '11'.repeat(32),
});

test('computes the Rusty Kaspa v2.0.1 covenant-id oracle vector', () => {
  // Mirrors the covenant-oracle: versioned SPK (version 0 + a20 <blake2b(instance)> 87),
  // escrow value, authorizing outpoint txid=0x11*32 index 2.
  const output = {
     value: '100000000',
     scriptPublicKey: '0000aa20ac8f307576f0b57341ba3611d7bd77abed8436e0b2b0fdc588ebfb807d330ec287',
    covenant: null,
  };
  assert.equal(
    computeGenesisCovenantId(
      { transactionId: '11'.repeat(32), index: 2 },
      [{ index: 0, output }],
    ),
     'b23d429f1b2687673eeb0435521d3f6f0503d1db36d1f39fdec657ea092a52e2',
  );
});

test('constructs output zero with exact escrow, P2SH, and genesis binding', () => {
  const output = createGenesisGameOutput({ request, authorizingInput: 0, authorizingOutpoint: input() });
  assert.deepEqual(output, {
    value: '100000000',
     scriptPublicKey: '0000aa2014abd6e1a1375cf98ba92c1a7df018872c32347816d9b470d8a04444f8ed1df587',
    covenant: {
      authorizingInput: 0,
       covenantId: '3a14a0a339ba3b16e55d3395a1ad7ad19d9f745708eb9b52ac740599dd417ee8',
    },
  });
});

test('validates exact fee separation and approved change', () => {
  const changeScriptPublicKey = '000051';
  const transaction = tx({ inputAmount: playerLockSompi(request.stakeSompi) + request.feeSompi + 50n, changeValue: 50n, changeScriptPublicKey });
  assert.deepEqual(validateCreationTransaction(JSON.stringify(transaction), request, { authorizingInput: 0, changeScriptPublicKey }), transaction);
});

test('rejects fee substitution, covenant fee inputs, and redirected change', () => {
  const insufficientFee = tx({ inputAmount: playerLockSompi(request.stakeSompi) + request.feeSompi - 1n });
  assert.throws(() => validateCreationTransaction(JSON.stringify(insufficientFee), request, { authorizingInput: 0 }), { code: 'FEE_SUBSTITUTION' });

  const covenantInput = tx({ inputAmount: playerLockSompi(request.stakeSompi) + request.feeSompi });
  covenantInput.inputs[0].utxo.covenantId = '22'.repeat(32);
  assert.throws(() => validateCreationTransaction(JSON.stringify(covenantInput), request, { authorizingInput: 0 }), { code: 'INVALID_TRANSACTION' });

  const redirected = tx({ inputAmount: playerLockSompi(request.stakeSompi) + request.feeSompi + 50n, changeValue: 50n, changeScriptPublicKey: '000052' });
  assert.throws(() => validateCreationTransaction(JSON.stringify(redirected), request, { authorizingInput: 0, changeScriptPublicKey: '000051' }), { code: 'INVALID_TRANSACTION' });
});

test('allows only signature-script changes in wallet SafeJSON', () => {
  const prepared = tx({ inputAmount: playerLockSompi(request.stakeSompi) + request.feeSompi });
  const signed = structuredClone(prepared);
  signed.inputs[0].signatureScript = '01aa';
  assert.deepEqual(verifySignedCreationSafeJson({
    preparedTxJson: JSON.stringify(prepared),
    signedTxJson: JSON.stringify(signed),
    request,
    policy: { authorizingInput: 0 },
  }), signed);

  signed.payload = '01';
  assert.throws(() => verifySignedCreationSafeJson({
    preparedTxJson: JSON.stringify(prepared),
    signedTxJson: JSON.stringify(signed),
    request,
    policy: { authorizingInput: 0 },
  }), { code: 'SIGNED_TRANSACTION_MISMATCH' });
});

function input(amount = playerLockSompi(request.stakeSompi) + request.feeSompi) {
  return {
    transactionId: '11'.repeat(32),
    index: 2,
    sequence: '0',
    sigOpCount: 0,
    computeBudget: 0,
    signatureScript: '',
    utxo: {
      amount: String(amount),
      scriptPublicKey: '000051',
      blockDaaScore: '1',
      isCoinbase: false,
      covenantId: null,
    },
  };
}

function tx({ inputAmount, changeValue, changeScriptPublicKey } = {}) {
  const genesisInput = input(inputAmount);
  const outputs = [createGenesisGameOutput({ request, authorizingInput: 0, authorizingOutpoint: genesisInput })];
  if (changeValue !== undefined) outputs.push({ value: String(changeValue), scriptPublicKey: changeScriptPublicKey, covenant: null });
  return {
    id: '00'.repeat(32),
    version: 1,
    inputs: [genesisInput],
    outputs,
    subnetworkId: '00'.repeat(20),
    lockTime: '0',
    gas: '0',
    storageMass: '0',
    payload: '',
  };
}
