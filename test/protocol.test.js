import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInvite, serializeInvite } from '../src/invite.js';
import { MemoryGameStore, prepareCreateGame } from '../src/create-game.js';
import { ProtocolError, stakeToSompi, playerLockSompi, grossPotSompi, gameFeeSompi, winnerPayoutSompi, validateGameFeeAddress, resolveGameFeePublicKey } from '../src/protocol.js';
import { bech32Encode } from '../src/hashes/bech32.mjs';
import { KaspaCreationConfirmer, submitSignedTransaction } from '../src/kaspa-adapter.js';
import { KaswareWalletAdapter, waitForKaswareProvider } from '../src/kasware-wallet.js';
import { createGenesisGameOutput } from '../src/genesis-transaction.js';

const valid = {
  network: 'testnet-10',
  creatorAddress: 'kaspatest:creator',
  creatorPublicKey: '07'.repeat(32),
  creatorCommitment: '09'.repeat(32),
  deadlineDaa: 500000000000n,
  side: 'even',
  stakeKas: 1,
  feeSompi: 1000n,
  gameFeePublicKey: '11'.repeat(32),
};

const feePublicKey = '11'.repeat(32);
const feeAddress = bech32Encode('kaspatest', 0, Buffer.from(feePublicKey, 'hex'));

test('converts KAS to exact sompi without floating point', () => {
  assert.equal(stakeToSompi(1), 100_000_000n);
  assert.equal(stakeToSompi(1_000_000), 100_000_000_000_000n);
  assert.throws(() => stakeToSompi(1.5), { code: 'INVALID_STAKE' });
  assert.throws(() => stakeToSompi(1_000_001), { code: 'INVALID_STAKE' });
});

test('rejects a per-player stake below 1 KAS', () => {
  assert.throws(() => playerLockSompi(99_999_999n), { code: 'INVALID_STAKE' });
  assert.equal(playerLockSompi(100_000_000n), 100_000_000n);
});

test('uses the full stake as each lock and charges one fee on the total pot', () => {
  const stake = 100_000_000n;
  assert.equal(playerLockSompi(stake), stake);
  assert.equal(grossPotSompi(stake), 200_000_000n);
  assert.equal(gameFeeSompi(stake), 2_000_000n);
  assert.equal(winnerPayoutSompi(stake), 198_000_000n);
  assert.equal(winnerPayoutSompi(stake) + gameFeeSompi(stake), grossPotSompi(stake));
});

test('decodes the payer fee public key from a version-0 wallet address', () => {
  assert.equal(validateGameFeeAddress(feeAddress), feePublicKey);
});

test('rejects invalid fee addresses and treats missing fee configuration as unconfigured', () => {
  assert.throws(() => validateGameFeeAddress('kaspatest:not-an-address'), { code: 'INVALID_GAME_FEE' });
  assert.throws(() => validateGameFeeAddress(bech32Encode('kaspa', 0, Buffer.from(feePublicKey, 'hex'))), { code: 'INVALID_GAME_FEE' });
  assert.equal(resolveGameFeePublicKey({}), null);
});

test('prefers the configured fee address over the raw public key', () => {
  assert.equal(resolveGameFeePublicKey({ GAME_FEE_ADDRESS: feeAddress }), feePublicKey);
  assert.equal(resolveGameFeePublicKey({ GAME_FEE_ADDRESS: feeAddress, GAME_FEE_PUBLIC_KEY: '22'.repeat(32) }), feePublicKey);
  assert.equal(resolveGameFeePublicKey({ GAME_FEE_PUBLIC_KEY: '22'.repeat(32) }), '22'.repeat(32));
});

test('prepares deterministic game metadata and separates fees', () => {
  const request = prepareCreateGame(valid);
  assert.equal(request.stakeSompi, 100_000_000n);
  assert.equal(request.feeSompi, 1000n);
  assert.match(request.covenantAddress, /^kaspatest:/);
  assert.match(request.covenantScriptPublicKey, /^aa20[0-9a-f]{64}87$/);
});

test('rejects wrong network and incomplete covenant state', () => {
  assert.throws(() => prepareCreateGame({ ...valid, network: 'mainnet' }), { code: 'WRONG_NETWORK' });
  assert.throws(() => prepareCreateGame({ ...valid, creatorCommitment: undefined }), { code: 'INVALID_GAME_STATE' });
});

test('serializes and parses an invite with only version and game id', () => {
  const gameId = 'b'.repeat(64);
  const invite = serializeInvite({ gameId, origin: 'https://example.test/create' });
  assert.equal(invite, `https://example.test/join?v=EO%2Fv5&game=${gameId}`);
  assert.deepEqual(parseInvite(invite, 'https://example.test'), { protocolVersion: 'EO/v5', network: 'testnet-10', gameId, creation: null });
  assert.throws(() => parseInvite(`${invite}&secret=do-not-accept`, 'https://example.test'), { code: 'INVALID_INVITE' });
});

test('serializes and parses an invite carrying the full creation state', () => {
  const gameId = 'b'.repeat(64);
  const creation = {
    creatorPublicKey: '07'.repeat(32),
    creatorCommitment: '09'.repeat(32),
    side: 'even',
    stakeKas: 5,
    deadlineDaa: 500000000123n,
    creatorAddress: 'kaspatest:creator',
  };
  const invite = serializeInvite({ gameId, origin: 'https://example.test/create', creation });
  const parsed = parseInvite(invite, 'https://example.test');
  assert.deepEqual(parsed.creation, creation);
  assert.deepEqual(parsed.gameId, gameId);
  assert.throws(() => parseInvite(`${invite}&zz=1`, 'https://example.test'), { code: 'INVALID_INVITE' });
});

test('confirms creation before producing an invite', async () => {
  const events = [];
  const transactionId = 'c'.repeat(64);
  const request = prepareCreateGame(valid);
  const prepared = preparedCreationFor(request);
  const result = await (await import('../src/create-game.js')).createAndConfirmGame({
    request,
    wallet: { sign: async (value) => { events.push(value); return signedSafeJson(prepared.txJson); } },
    chain: {
      prepareCreation: async () => prepared,
      verifySignedCreation: async ({ signedTxJson }) => ({ signedTxJson }),
      submitCreation: async () => transactionId,
      confirmCreation: async () => ({ status: 'confirmed' }),
    },
    inviteOrigin: 'https://example.test',
    store: new MemoryGameStore(),
  });
  assert.equal(events.length, 1);
  assert.equal(result.gameId, transactionId);
  assert.match(result.inviteUrl, /\/join\?/);
});

test('uses typed protocol errors', () => {
  assert.throws(() => prepareCreateGame({ ...valid, side: 'random' }), (error) => error instanceof ProtocolError && error.code === 'INVALID_SIDE');
});

test('submits through the Rusty Kaspa v2 object-shaped RPC boundary', async () => {
  const transaction = { version: 1 };
  const txid = await submitSignedTransaction({
    rpc: { submitTransaction: async (value) => { assert.deepEqual(value, { transaction, allowOrphan: false }); return { transactionId: 'tx-2' }; } },
    transaction,
  });
  assert.equal(txid, 'tx-2');
});

test('connects supported KasWare and signs exact prepared SafeJSON', async () => {
  const listeners = new Map();
  const provider = {
    requestAccounts: async () => [valid.creatorAddress],
    getPublicKey: async () => `02${'ab'.repeat(32)}`,
    getNetwork: async () => 'kaspa_testnet_10',
    getAccounts: async () => [valid.creatorAddress],
    signPskt: async (request) => { assert.equal(request.txJsonString, 'unsigned'); return 'signed'; },
    on: (event, handler) => listeners.set(event, handler),
    removeListener: (event) => listeners.delete(event),
  };
  const wallet = new KaswareWalletAdapter(provider);
  const account = await wallet.connect();
  assert.equal(account.publicKey, 'ab'.repeat(32));
  const result = await wallet.sign({ network: 'testnet-10', creatorAddress: valid.creatorAddress, txJson: 'unsigned', preparedHash: 'hash' });
  assert.equal(result, 'signed');
  listeners.get('networkChanged')('kaspa_mainnet');
  await assert.rejects(() => wallet.sign({ network: 'testnet-10', creatorAddress: valid.creatorAddress, txJson: 'unsigned', preparedHash: 'hash' }), { code: 'WALLET_CHANGED' });
  wallet.dispose();
});

test('requests a KasWare network switch when the wallet is on another network', async () => {
  let network = 'kaspa_mainnet';
  const switches = [];
  const provider = {
    requestAccounts: async () => [valid.creatorAddress],
    getPublicKey: async () => 'ab'.repeat(32),
    getNetwork: async () => network,
    switchNetwork: async (next) => { switches.push(next); network = next; },
    getAccounts: async () => [valid.creatorAddress],
    signPskt: async () => 'signed',
  };
  const wallet = new KaswareWalletAdapter(provider);
  const account = await wallet.connect();
  assert.deepEqual(switches, ['kaspa_testnet_10']);
  assert.equal(account.network, 'testnet-10');
});

test('rejects a KasWare connection that is not approved', async () => {
  const wallet = new KaswareWalletAdapter({ requestAccounts: async () => [] });
  await assert.rejects(() => wallet.connect(), { code: 'WALLET_REJECTED' });
});

test('rejects a KasWare account that does not support signing', async () => {
  const wallet = new KaswareWalletAdapter({
    requestAccounts: async () => [valid.creatorAddress],
    getPublicKey: async () => 'ab'.repeat(32),
    getNetwork: async () => 'kaspa_testnet_10',
  });
  await assert.rejects(() => wallet.connect(), { code: 'WALLET_UNSUPPORTED' });
});

test('detects late KasWare injection and rejects a mainnet account prefix', async () => {
  let reads = 0;
  const provider = { requestAccounts: async () => [valid.creatorAddress] };
  assert.equal(await waitForKaswareProvider({
    getProvider: () => (++reads === 2 ? provider : undefined),
    wait: async () => {},
  }), provider);

  const wallet = new KaswareWalletAdapter({
    requestAccounts: async () => ['kaspa:mainnet'],
    getPublicKey: async () => 'ab'.repeat(32),
    getNetwork: async () => 'kaspa_testnet_10',
    getAccounts: async () => ['kaspa:mainnet'],
    signPskt: async () => 'signed',
  });
  await assert.rejects(() => wallet.connect(), { code: 'WALLET_ACCOUNT_MISMATCH' });
});

test('confirms a creation only after its covenant UTXO has one DAA confirmation', async () => {
  let reads = 0;
  const confirmer = new KaspaCreationConfirmer({
    rpc: {
      getUtxosByAddresses: async () => ({ entries: [{ outpoint: { transactionId: 'tx-1', index: 0 }, amount: '100000000', scriptPublicKey: { script: 'aa20' }, blockDaaScore: '50' }] }),
      getBlockDagInfo: async () => ({ virtualDaaScore: String(50 + reads++) }),
    },
    covenantAddress: prepareCreateGame(valid).covenantAddress,
    playerLockSompi: 100_000_000n,
    scriptPublicKey: 'aa20',
    attempts: 3,
    wait: async () => {},
  });
  assert.deepEqual(await confirmer.confirmCreation({ transactionId: 'tx-1' }), {
    status: 'confirmed',
    acceptingDaaScore: '50',
    confirmedDaaScore: '51',
  });
});

function preparedCreationFor(request) {
  const policy = { authorizingInput: 0 };
  const input = {
    transactionId: '11'.repeat(32), index: 2, sequence: '0', sigOpCount: 0, computeBudget: 0, signatureScript: '',
  utxo: { amount: String(playerLockSompi(request.stakeSompi) + request.feeSompi), scriptPublicKey: '000051', blockDaaScore: '1', isCoinbase: false, covenantId: null },
  };
  const output = createOutput(request, input);
  return {
    network: request.network,
    creatorAddress: request.creatorAddress,
    preparedHash: 'ab'.repeat(32),
    policy,
    txJson: JSON.stringify({ id: '00'.repeat(32), version: 1, inputs: [input], outputs: [output], subnetworkId: '00'.repeat(20), lockTime: '0', gas: '0', storageMass: '0', payload: '' }),
  };
}

function createOutput(request, input) {
  return createGenesisGameOutput({ request, authorizingInput: 0, authorizingOutpoint: input });
}

function signedSafeJson(txJson) {
  const transaction = JSON.parse(txJson);
  transaction.inputs[0].signatureScript = '01aa';
  return JSON.stringify(transaction);
}
