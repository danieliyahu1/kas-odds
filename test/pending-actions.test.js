import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameService } from '../src/backend-game-service.js';
import { BackendGameStore } from '../src/backend-game-store.js';
import { prepareCreateGame } from '../src/create-game.js';

const NETWORK = 'testnet-10';
const GAME_FEE_PUBLIC_KEY = '11'.repeat(32);
const GAME_ID = 'ff'.repeat(32);
const CREATOR_ADDRESS = 'kaspatest:creator';
const JOINER_ADDRESS = 'kaspatest:joiner';
const CREATOR_PUBLIC_KEY = 'aa'.repeat(32);
const JOINER_PUBLIC_KEY = 'bb'.repeat(32);
const GROSS_POT = '200000000';

function serializedRequest() {
  const request = prepareCreateGame({
    network: NETWORK,
    creatorAddress: CREATOR_ADDRESS,
    creatorPublicKey: CREATOR_PUBLIC_KEY,
    creatorCommitment: 'cc'.repeat(32),
    deadlineDaa: 10_000n,
    side: 'even',
    stakeKas: 1,
    feeSompi: 1_000n,
    gameFeePublicKey: GAME_FEE_PUBLIC_KEY,
  });
  return Object.fromEntries(Object.entries(request).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]));
}

function baseRecord(overrides = {}) {
  return {
    gameId: GAME_ID,
    protocolVersion: 'EO/v5',
    status: 'joined',
    request: serializedRequest(),
    prepared: {
      network: NETWORK,
      creatorAddress: CREATOR_ADDRESS,
      txJson: '{}',
      preparedHash: '07'.repeat(32),
      policy: {},
      feeSompi: '1000',
      covenantId: '03'.repeat(32),
      scriptPublicKey: '0000aa20' + '02'.repeat(32) + '87',
    },
    join: {
      transactionId: 'dd'.repeat(32),
      preparedHash: '01'.repeat(32),
      joinerAddress: JOINER_ADDRESS,
      joinerPublicKey: JOINER_PUBLIC_KEY,
      joinerCommitment: 'ee'.repeat(32),
      joinedAddress: 'kaspatest:joined',
      joinedScriptPublicKey: '0000aa20' + '02'.repeat(32) + '87',
      joinedRedeemScript: 'ab'.repeat(32),
      covenantId: '03'.repeat(32),
      submittedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function pendingReveal({ transactionId, address, scriptPublicKey, submittedAt, role = 'creator', playerAddress = CREATOR_ADDRESS, winner = null }) {
  return {
    transactionId,
    preparedHash: '04'.repeat(32),
    playerAddress,
    role,
    choice: role === 'creator' ? 1 : 0,
    status: 'broadcast',
    winner,
    continuationAddress: address,
    continuationScriptPublicKey: scriptPublicKey,
    continuationRedeemScript: 'cd'.repeat(32),
    submittedAt,
  };
}

function pendingRefund({ transactionId, address, scriptPublicKey, continuationOutputIndex = 1, submittedAt }) {
  return {
    action: 'refund_player',
    transactionId,
    preparedHash: '05'.repeat(32),
    playerAddress: CREATOR_ADDRESS,
    role: 'creator',
    status: 'broadcast',
    continuationAddress: address,
    continuationScriptPublicKey: scriptPublicKey,
    continuationRedeemScript: 'ce'.repeat(32),
    continuationOutputIndex,
    submittedAt,
  };
}

// Reports the output at `confirmedAddress` and nothing else, mimicking a chain
// where only the attempt the network accepted exists.
function rpc({ confirmedAddress, confirmedTransactionId, confirmedScriptPublicKey, outputIndex = 0, amount = GROSS_POT, dag = '3000' }) {
  return {
    getBlockDagInfo: async () => ({ virtualDaaScore: dag }),
    getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
    getUtxosByAddresses: async (addresses) => {
      const [address] = addresses;
      if (confirmedAddress && address === confirmedAddress) {
        return {
          entries: [{
            outpoint: { transactionId: confirmedTransactionId, index: outputIndex },
            amount,
            scriptPublicKey: confirmedScriptPublicKey,
            blockDaaScore: 100,
            isCoinbase: false,
          }],
        };
      }
      return { entries: [] };
    },
  };
}

async function withRecord(t, record, rpcOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-pending-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(join(directory, 'games.json'));
  await store.saveGame(record);
  const service = new BackendGameService({ rpc: rpc(rpcOptions), store, gameFeePublicKey: GAME_FEE_PUBLIC_KEY });
  return { service, store };
}

test('confirms the attempt the chain accepted and prunes the losing duplicates', async (t) => {
  const firstSpk = '0000aa20' + '0a'.repeat(32) + '87';
  const secondSpk = '0000aa20' + '0b'.repeat(32) + '87';
  const record = baseRecord({
    reveals: [
      pendingReveal({ transactionId: 'aa'.repeat(32), address: 'kaspatest:cont-a', scriptPublicKey: firstSpk, submittedAt: new Date().toISOString() }),
      pendingReveal({ transactionId: 'bb'.repeat(32), address: 'kaspatest:cont-b', scriptPublicKey: secondSpk, submittedAt: new Date().toISOString() }),
    ],
  });
  const { service, store } = await withRecord(t, record, {
    confirmedAddress: 'kaspatest:cont-b',
    confirmedTransactionId: 'bb'.repeat(32),
    confirmedScriptPublicKey: secondSpk,
  });

  const game = await service.readGame(GAME_ID);
  assert.equal(game.status, 'first_revealed');
  assert.deepEqual(game.revealedPicks, { creator: 1 });
  assert.equal(game.pendingReveals.length, 0);

  const stored = await store.loadGame(GAME_ID);
  assert.equal(stored.reveals.length, 1, 'only the accepted attempt survives');
  assert.equal(stored.reveals[0].transactionId, 'bb'.repeat(32));
  assert.equal(stored.reveals[0].status, 'confirmed');
});

test('prunes a rival attempt for the same step once one confirms', async (t) => {
  const creatorSpk = '0000aa20' + '0a'.repeat(32) + '87';
  const joinerSpk = '0000aa20' + '0b'.repeat(32) + '87';
  const record = baseRecord({
    reveals: [
      pendingReveal({ transactionId: 'aa'.repeat(32), address: 'kaspatest:cont-a', scriptPublicKey: creatorSpk, submittedAt: new Date().toISOString() }),
      pendingReveal({ transactionId: 'bb'.repeat(32), address: 'kaspatest:cont-b', scriptPublicKey: joinerSpk, submittedAt: new Date().toISOString(), role: 'joiner', playerAddress: JOINER_ADDRESS }),
    ],
  });
  const { service, store } = await withRecord(t, record, {
    confirmedAddress: 'kaspatest:cont-a',
    confirmedTransactionId: 'aa'.repeat(32),
    confirmedScriptPublicKey: creatorSpk,
  });

  const game = await service.readGame(GAME_ID);
  assert.equal(game.status, 'first_revealed');
  assert.deepEqual(game.revealedPicks, { creator: 1 });
  const stored = await store.loadGame(GAME_ID);
  assert.equal(stored.reveals.length, 1, 'the losing rival attempt is removed');
});

test('keeps the button locked for a fresh pending reveal', async (t) => {
  const spk = '0000aa20' + '0a'.repeat(32) + '87';
  const record = baseRecord({
    reveals: [pendingReveal({ transactionId: 'aa'.repeat(32), address: 'kaspatest:cont-a', scriptPublicKey: spk, submittedAt: new Date().toISOString() })],
  });
  const { service } = await withRecord(t, record, {});

  const game = await service.readGame(GAME_ID);
  assert.equal(game.status, 'reveal_broadcast');
  assert.equal(game.canReveal, false);
  assert.equal(game.pendingReveals.length, 1);
  assert.equal(game.pendingReveals[0].retryable, false);
});

test('unlocks the button after a minute but keeps the original attempt', async (t) => {
  const spk = '0000aa20' + '0a'.repeat(32) + '87';
  const stale = new Date(Date.now() - 2 * 60_000).toISOString();
  const record = baseRecord({
    reveals: [pendingReveal({ transactionId: 'aa'.repeat(32), address: 'kaspatest:cont-a', scriptPublicKey: spk, submittedAt: stale })],
  });
  const { service, store } = await withRecord(t, record, {});

  const game = await service.readGame(GAME_ID);
  assert.equal(game.status, 'reveal_broadcast');
  assert.equal(game.pendingReveals[0].retryable, true);
  const stored = await store.loadGame(GAME_ID);
  assert.equal(stored.reveals.length, 1, 'the original attempt is not discarded');
  assert.equal(stored.reveals[0].status, 'broadcast');
});

test('confirms a safety action and prunes its duplicates', async (t) => {
  const firstSpk = '0000aa20' + '0c'.repeat(32) + '87';
  const secondSpk = '0000aa20' + '0d'.repeat(32) + '87';
  const record = baseRecord({
    status: 'refund_player_broadcast',
    safetyActions: [
      pendingRefund({ transactionId: 'cc'.repeat(32), address: 'kaspatest:refund-a', scriptPublicKey: firstSpk, submittedAt: new Date().toISOString() }),
      pendingRefund({ transactionId: 'ee'.repeat(32), address: 'kaspatest:refund-b', scriptPublicKey: secondSpk, submittedAt: new Date().toISOString() }),
    ],
  });
  const { service, store } = await withRecord(t, record, {
    confirmedAddress: 'kaspatest:refund-b',
    confirmedTransactionId: 'ee'.repeat(32),
    confirmedScriptPublicKey: secondSpk,
    outputIndex: 1,
    amount: '100000000',
  });

  const game = await service.readGame(GAME_ID);
  assert.equal(game.status, 'refund_partial');
  assert.equal(game.pendingSafety.length, 0);
  const stored = await store.loadGame(GAME_ID);
  assert.equal(stored.safetyActions.length, 1);
  assert.equal(stored.safetyActions[0].transactionId, 'ee'.repeat(32));
  assert.equal(stored.safetyActions[0].status, 'confirmed');
});
