import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAndConfirmGame,
  createOperationKey,
  MemoryGameStore,
  prepareCreateGame,
  recoverCreateGame,
} from '../src/create-game.js';
import { createGenesisGameOutput } from '../src/genesis-transaction.js';
import { playerLockSompi } from '../src/protocol.js';

const transactionId = 'c'.repeat(64);
const request = prepareCreateGame({
  network: 'testnet-10',
  creatorAddress: 'kaspatest:creator',
  creatorPublicKey: '07'.repeat(32),
  creatorCommitment: '09'.repeat(32),
  deadlineDaa: 500000000000n,
  side: 'odd',
  stakeKas: 12,
  feeSompi: 1_000n,
  gameFeePublicKey: '11'.repeat(32),
});
const input = {
  transactionId: '11'.repeat(32), index: 2, sequence: '0', sigOpCount: 0, computeBudget: 0, signatureScript: '',
  utxo: { amount: String(playerLockSompi(request.stakeSompi) + request.feeSompi), scriptPublicKey: '000051', blockDaaScore: '1', isCoinbase: false, covenantId: null },
};
const policy = { authorizingInput: 0 };
const transaction = {
  id: '00'.repeat(32),
  version: 1,
  inputs: [input],
  outputs: [createGenesisGameOutput({ request, authorizingInput: 0, authorizingOutpoint: input })],
  subnetworkId: '00'.repeat(20),
  lockTime: '0',
  gas: '0',
  storageMass: '0',
  payload: '',
};
const prepared = {
  network: request.network,
  creatorAddress: request.creatorAddress,
  txJson: JSON.stringify(transaction),
  preparedHash: 'ab'.repeat(32),
  policy,
};

function createBoundaries(overrides = {}) {
  const calls = { signed: 0, submitted: 0, confirmed: 0 };
  return {
    calls,
    wallet: {
      sign: async (value) => {
        calls.signed += 1;
        assert.deepEqual(value, prepared);
        return signedSafeJson(prepared.txJson);
      },
    },
    chain: {
      prepareCreation: async () => prepared,
      verifySignedCreation: async ({ request: actualRequest, prepared: actualPrepared, signedTxJson }) => {
        assert.equal(actualRequest, request);
        assert.equal(actualPrepared, prepared);
        assert.match(signedTxJson, /01aa/);
        return { version: 1, signedTxJson };
      },
      submitCreation: async () => {
        calls.submitted += 1;
        return transactionId;
      },
      confirmCreation: async () => {
        calls.confirmed += 1;
        return { status: 'confirmed', acceptingDaaScore: 50n, confirmedDaaScore: 51n };
      },
      ...overrides,
    },
  };
}

test('creates, checkpoints, confirms, and exposes only the confirmed invite', async () => {
  const store = new MemoryGameStore();
  const { wallet, chain, calls } = createBoundaries();

  const result = await createAndConfirmGame({ request, wallet, chain, store, inviteOrigin: 'https://example.test/create?secret=no' });

  assert.deepEqual(result, {
    status: 'confirmed',
    message: 'Game created. Waiting for Player B.',
    transactionId,
    gameId: transactionId,
    inviteUrl: `https://example.test/join?v=EO%2Fv5&game=${transactionId}`,
  });
  assert.deepEqual(calls, { signed: 1, submitted: 1, confirmed: 1 });
  const saved = await store.load(createOperationKey(prepared));
  assert.equal(saved.status, 'confirmed');
  assert.equal(saved.preparedTxJson, prepared.txJson);
  assert.deepEqual(saved.policy, policy);
  assert.equal(saved.acceptingDaaScore, '50');
  assert.equal(saved.confirmedDaaScore, '51');
  assert.equal(JSON.stringify(saved).includes('01aa'), false);
});

test('rejects a wallet-signed transaction that reduces output zero to pay fees', async () => {
  const { chain, calls } = createBoundaries();
  const wallet = {
    sign: async () => {
      const signed = JSON.parse(signedSafeJson(prepared.txJson));
      signed.outputs[0].value = String(playerLockSompi(request.stakeSompi) - 1n);
      return JSON.stringify(signed);
    },
  };

  await assert.rejects(
    () => createAndConfirmGame({ request, wallet, chain, store: new MemoryGameStore(), inviteOrigin: 'https://example.test' }),
    { code: 'INVALID_TRANSACTION' },
  );
  assert.equal(calls.submitted, 0);
});

function signedSafeJson(txJson) {
  const signed = JSON.parse(txJson);
  signed.inputs[0].signatureScript = '01aa';
  return JSON.stringify(signed);
}

test('does not sign or broadcast again after an ambiguous client restart', async () => {
  const store = new MemoryGameStore();
  const first = createBoundaries();
  await createAndConfirmGame({ request, wallet: first.wallet, chain: first.chain, store, inviteOrigin: 'https://example.test' });
  const second = createBoundaries();

  await createAndConfirmGame({ request, wallet: second.wallet, chain: second.chain, store, inviteOrigin: 'https://example.test' });

  assert.deepEqual(second.calls, { signed: 0, submitted: 0, confirmed: 1 });
});

test('persists broadcast state but refuses an invite until confirmation', async () => {
  const store = new MemoryGameStore();
  const { wallet, chain } = createBoundaries({ confirmCreation: async () => ({ status: 'observed' }) });

  await assert.rejects(
    () => createAndConfirmGame({ request, wallet, chain, store, inviteOrigin: 'https://example.test' }),
    { code: 'NOT_CONFIRMED' },
  );
  const saved = await store.load(createOperationKey(prepared));
  assert.equal(saved.status, 'observed');
  assert.equal(saved.transactionId, transactionId);
  assert.equal('inviteUrl' in saved, false);
});

test('demotes a previously confirmed creation after a reorg', async () => {
  const store = new MemoryGameStore();
  const initial = createBoundaries();
  await createAndConfirmGame({ request, wallet: initial.wallet, chain: initial.chain, store, inviteOrigin: 'https://example.test' });
  const reorged = createBoundaries({ confirmCreation: async () => ({ status: 'reorged' }) });

  await assert.rejects(
    () => recoverCreateGame({ operationKey: createOperationKey(prepared), request, chain: reorged.chain, store, inviteOrigin: 'https://example.test' }),
    { code: 'CREATION_REORGED' },
  );
  assert.equal((await store.load(createOperationKey(prepared))).status, 'reorged');
});

test('records refusal without persisting signed material or broadcasting', async () => {
  const store = new MemoryGameStore();
  const { chain, calls } = createBoundaries();
  const wallet = { sign: async () => { throw Object.assign(new Error('Transaction signing was cancelled.'), { code: 'WALLET_REJECTED' }); } };

  await assert.rejects(
    () => createAndConfirmGame({ request, wallet, chain, store, inviteOrigin: 'https://example.test' }),
    { code: 'WALLET_REJECTED' },
  );
  const saved = await store.load(createOperationKey(prepared));
  assert.equal(saved.status, 'rejected');
  assert.equal(saved.lastError.message, 'Transaction signing was cancelled.');
  assert.equal(calls.submitted, 0);
});

test('fails closed when prepared SafeJSON does not match the requested account', async () => {
  const { wallet, chain, calls } = createBoundaries({
    prepareCreation: async () => ({ ...prepared, creatorAddress: 'kaspatest:attacker' }),
  });

  await assert.rejects(
    () => createAndConfirmGame({ request, wallet, chain, store: new MemoryGameStore(), inviteOrigin: 'https://example.test' }),
    { code: 'INVALID_TRANSACTION' },
  );
  assert.equal(calls.signed, 0);
  assert.equal(calls.submitted, 0);
});

test('fails closed when prepared SafeJSON was built for a different network', async () => {
  const { wallet, chain, calls } = createBoundaries({
    prepareCreation: async () => ({ ...prepared, network: 'mainnet' }),
  });

  await assert.rejects(
    () => createAndConfirmGame({ request, wallet, chain, store: new MemoryGameStore(), inviteOrigin: 'https://example.test' }),
    { code: 'INVALID_TRANSACTION' },
  );
  assert.equal(calls.signed, 0);
  assert.equal(calls.submitted, 0);
});

test('does not sign or broadcast when an RPC outage prevents preparing the creation', async () => {
  const { wallet, calls } = createBoundaries({
    prepareCreation: async () => { throw Object.assign(new Error('Failed to read UTXOs: connection refused'), { code: 'RPC_ERROR' }); },
  });

  await assert.rejects(
    () => createAndConfirmGame({ request, wallet, chain: { prepareCreation: async () => { throw Object.assign(new Error('Failed to read UTXOs: connection refused'), { code: 'RPC_ERROR' }); }, verifySignedCreation: async () => ({}), submitCreation: async () => transactionId, confirmCreation: async () => ({ status: 'confirmed' }) }, store: new MemoryGameStore(), inviteOrigin: 'https://example.test' }),
    { code: 'RPC_ERROR' },
  );
  assert.equal(calls.signed, 0);
  assert.equal(calls.submitted, 0);
});

test('recovers a partially broadcast creation without rebroadcasting on a later RPC outage', async () => {
  const store = new MemoryGameStore();
  const partial = createBoundaries({ confirmCreation: async () => ({ status: 'observed' }) });
  await assert.rejects(
    () => createAndConfirmGame({ request, wallet: partial.wallet, chain: partial.chain, store, inviteOrigin: 'https://example.test' }),
    { code: 'NOT_CONFIRMED' },
  );
  const saved = await store.load(createOperationKey(prepared));
  assert.equal(saved.status, 'observed');
  assert.equal(saved.transactionId, transactionId);

  const retry = createBoundaries();
  await createAndConfirmGame({ request, wallet: retry.wallet, chain: retry.chain, store, inviteOrigin: 'https://example.test' });
  assert.deepEqual(retry.calls, { signed: 0, submitted: 0, confirmed: 1 });
  assert.equal((await store.load(createOperationKey(prepared))).status, 'confirmed');
});

test('marks a creation stale and refuses an invite when the tracked UTXO is no longer observed', async () => {
  const store = new MemoryGameStore();
  const { wallet, chain } = createBoundaries({ confirmCreation: async () => ({ status: 'stale' }) });

  await assert.rejects(
    () => createAndConfirmGame({ request, wallet, chain, store, inviteOrigin: 'https://example.test' }),
    { code: 'NOT_CONFIRMED' },
  );
  const saved = await store.load(createOperationKey(prepared));
  assert.equal(saved.status, 'stale');
  assert.equal('inviteUrl' in saved, false);
});

test('surfaces a stale-input submission failure without persisting signed material', async () => {
  const store = new MemoryGameStore();
  const { wallet, chain, calls } = createBoundaries({
    submitCreation: async () => { throw Object.assign(new Error('Transaction would create double spend'), { code: 'SUBMISSION_FAILED' }); },
  });

  await assert.rejects(
    () => createAndConfirmGame({ request, wallet, chain, store, inviteOrigin: 'https://example.test' }),
    { code: 'SUBMISSION_FAILED' },
  );
  const saved = await store.load(createOperationKey(prepared));
  assert.equal(saved.transactionId, undefined);
  assert.equal(saved.status, 'partially_signed');
  assert.equal(calls.confirmed, 0);
  assert.equal(JSON.stringify(saved).includes('01aa'), false);
});

test('records a user cancellation as rejected without broadcasting or retaining secrets', async () => {
  const store = new MemoryGameStore();
  const { chain, calls } = createBoundaries();
  const wallet = { sign: async () => { throw Object.assign(new Error('No'), { code: 4001 }); } };

  await assert.rejects(
    () => createAndConfirmGame({ request, wallet, chain, store, inviteOrigin: 'https://example.test' }),
    { code: 4001 },
  );
  const saved = await store.load(createOperationKey(prepared));
  assert.equal(saved.status, 'rejected');
  assert.equal(calls.submitted, 0);
  assert.equal(JSON.stringify(saved).includes('01aa'), false);
});

test('round-trips a recovery after a signed-template mutation is rejected during signing verification', async () => {
  const store = new MemoryGameStore();
  const badWallet = {
    sign: async () => {
      const signed = JSON.parse(signedSafeJson(prepared.txJson));
      signed.outputs[0].value = String(playerLockSompi(request.stakeSompi) - 1n);
      return JSON.stringify(signed);
    },
  };
  await assert.rejects(
    () => createAndConfirmGame({ request, wallet: badWallet, chain: createBoundaries().chain, store, inviteOrigin: 'https://example.test' }),
    { code: 'INVALID_TRANSACTION' },
  );
  assert.equal((await store.load(createOperationKey(prepared))).status, 'partially_signed');
  assert.equal((await store.load(createOperationKey(prepared))).transactionId, undefined);
});
