import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameService } from '../src/backend-game-service.js';
import { BackendGameStore } from '../src/backend-game-store.js';
import { createRevealSecret } from '../src/reveal.js';
import { prepareCreateGame, normalizePublicKey } from '../src/create-game.js';
import { loadWasmSdk } from '../src/wasm-transaction.js';

const NETWORK = 'testnet-10';
const GAME_FEE_PUBLIC_KEY = '11'.repeat(32);
const creatorSecret = createRevealSecret({ gameId: 'ff'.repeat(32), player: 'creator', choice: 1, nonce: new Uint8Array(32).fill(7) });
const joinerSecret = createRevealSecret({ gameId: 'ff'.repeat(32), player: 'joiner', choice: 0, nonce: new Uint8Array(32).fill(8) });
const CREATOR_ADDRESS = 'kaspatest:creator';
const JOINER_ADDRESS = 'kaspatest:joiner';
const CREATOR_PUBLIC_KEY = 'aa'.repeat(32);
const JOINER_PUBLIC_KEY = 'bb'.repeat(32);

// Every 1 KAS lock paid out as a second-reveal settlement carries two outputs
// (winner 0.2 KAS game-fee + winner payout) plus a change output. A single
// large funding UTXO pushes stored value so high the storage mass exceeds the
// 500,000 consensus limit; two smaller UTXOs keep it under. The service must
// select funding that keeps the prepared transaction relayable.
function storageMass(tx) {
  return Number(loadWasmSdk().calculateStorageMass(
    NETWORK,
    tx.inputs.map((input) => Number(input.utxo.amount)),
    tx.outputs.map((output) => Number(output.value)),
  ));
}

function serializedRequest() {
  const request = prepareCreateGame({
    network: NETWORK,
    creatorAddress: CREATOR_ADDRESS,
    creatorPublicKey: CREATOR_PUBLIC_KEY,
    creatorCommitment: creatorSecret.commitment,
    deadlineDaa: 10_000n,
    side: 'even',
    stakeKas: 1,
    feeSompi: 1_000n,
    gameFeePublicKey: GAME_FEE_PUBLIC_KEY,
  });
  return Object.fromEntries(Object.entries(request).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]));
}

function gameRecord() {
  const request = serializedRequest();
  return {
    gameId: 'ff'.repeat(32),
    protocolVersion: 'EO/v5',
    status: 'first_revealed',
    request,
    join: {
      transactionId: 'dd'.repeat(32),
      preparedHash: '01'.repeat(32),
      joinerAddress: JOINER_ADDRESS,
      joinerPublicKey: JOINER_PUBLIC_KEY,
      joinerCommitment: joinerSecret.commitment,
      joinedAddress: 'kaspatest:joined',
      joinedScriptPublicKey: '0000aa20' + '02'.repeat(32) + '87',
      joinedRedeemScript: 'ab'.repeat(32),
      covenantId: '03'.repeat(32),
      submittedAt: new Date().toISOString(),
    },
    reveals: [{
      transactionId: 'ee'.repeat(32),
      preparedHash: '04'.repeat(32),
      playerAddress: JOINER_ADDRESS,
      role: 'joiner',
      choice: joinerSecret.choice,
      status: 'confirmed',
      confirmedDaaScore: '2000',
      continuationAddress: 'kaspatest:continuation',
      continuationScriptPublicKey: '0000aa20' + '05'.repeat(32) + '87',
      continuationRedeemScript: '06'.repeat(32),
      winner: null,
      submittedAt: new Date().toISOString(),
    }],
  };
}

function ordinaryUtxo(txidByte, amount) {
  return {
    outpoint: { transactionId: `${String(txidByte).padStart(2, '0')}`.repeat(32), index: 0 },
    amount: String(amount),
    scriptPublicKey: `000020${'88'.repeat(32)}ac`,
    blockDaaScore: 100,
    isCoinbase: false,
  };
}

function rpcFor(ordinaryUtxos) {
  return {
    getBlockDagInfo: async () => ({ virtualDaaScore: '3000' }),
    getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
    getUtxosByAddresses: async (addresses) => {
      const [address] = addresses;
      if (address === 'kaspatest:continuation') {
        return { entries: [{
          outpoint: { transactionId: 'ee'.repeat(32), index: 0 },
          amount: '200000000',
          scriptPublicKey: '0000aa20' + '05'.repeat(32) + '87',
          blockDaaScore: 1999,
          isCoinbase: false,
        }] };
      }
      return { entries: ordinaryUtxos };
    },
  };
}

async function withService(t, ordinaryUtxos) {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-storage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(join(directory, 'games.json'));
  await store.saveGame(gameRecord());
  const service = new BackendGameService({ rpc: rpcFor(ordinaryUtxos), store, gameFeePublicKey: GAME_FEE_PUBLIC_KEY });
  return service;
}

test('second-reveal settlement selects storage-mass-safe funding instead of one huge UTXO', async (t) => {
  const huge = ordinaryUtxo(7, 2_535_839_900);
  const smallA = ordinaryUtxo(8, 100_000_000);
  const smallB = ordinaryUtxo(9, 100_000_000);
  const service = await withService(t, [huge, smallA, smallB]);
  const prepared = await service.prepareReveal('ff'.repeat(32), {
    playerAddress: CREATOR_ADDRESS,
    playerPublicKey: normalizePublicKey(CREATOR_PUBLIC_KEY),
    choice: creatorSecret.choice,
    nonceHex: creatorSecret.nonceHex,
  });
  const tx = JSON.parse(prepared.txJson);
  const feeOutPoint = String(tx.outputs.map((output) => BigInt(output.value)).includes(2_000_000n) ? 1 : 0);
  assert.equal(feeOutPoint, '1');
  assert.ok(storageMass(tx) <= 500_000, `storage mass ${storageMass(tx)} must stay under 500000`);
  const selectedTxids = tx.inputs.slice(1).map((input) => input.transactionId);
  assert.ok(!selectedTxids.includes(huge.outpoint.transactionId), 'the single huge UTXO must not be selected');
  assert.equal(selectedTxids.length, 2, 'two small funding UTXOs should fund the settlement');
});

test('second-reveal settlement fails early with a typed error when only one huge UTXO exists', async (t) => {
  const service = await withService(t, [ordinaryUtxo(7, 2_535_839_900)]);
  await assert.rejects(
    service.prepareReveal('ff'.repeat(32), {
      playerAddress: CREATOR_ADDRESS,
      playerPublicKey: normalizePublicKey(CREATOR_PUBLIC_KEY),
      choice: creatorSecret.choice,
      nonceHex: creatorSecret.nonceHex,
    }),
    { code: 'STORAGE_MASS_EXCEEDED' },
  );
});
