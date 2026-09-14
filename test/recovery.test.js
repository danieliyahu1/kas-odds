import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindWalletRecovery, classifyTransaction, createRecoveryLogger, JsonRecoveryStore, MemoryRecoveryStore, projectRecoveryState, reconstructGameState, reduceGameHistory, recoverAndCheckpoint, sanitizeRecord } from '../src/recovery.js';
import { KaswareWalletAdapter } from '../src/kasware-wallet.js';

test('classifies only authoritative one-confirmed transactions as confirmed', () => {
  assert.equal(classifyTransaction({ status: 'observed' }), 'pending');
  assert.equal(classifyTransaction({ status: 'confirmed', confirmations: 1 }), 'confirmed');
  assert.equal(classifyTransaction({ status: 'rejected' }), 'rejected');
  assert.equal(classifyTransaction({ supported: false }), 'unsupported');
  assert.equal(classifyTransaction({ conflicting: true }), 'conflicting');
  assert.equal(classifyTransaction({}), 'unknown');
});

test('reducer buffers pending events and replays after a removed block', () => {
  const events = [
    { transactionId: 'create', daaScore: 10, status: 'confirmed', confirmations: 1, state: { status: 'open' } },
    { transactionId: 'join', blockHash: 'removed', daaScore: 11, status: 'confirmed', confirmations: 1, state: { status: 'joined' } },
    { transactionId: 'reveal', daaScore: 12, status: 'pending', state: { status: 'revealed' } },
  ];
  const result = reduceGameHistory({ events, removedBlocks: ['removed'] });
  assert.deepEqual(result.state, { status: 'open' });
  assert.deepEqual(result.pendingTransactions, ['reveal']);
  assert.equal(result.rebuilt, true);
});

test('reorged checkpoint is discarded before replay', () => {
  const result = reduceGameHistory({
    checkpoint: { state: { status: 'joined' }, appliedTransactions: ['join'] },
    events: [
      { transactionId: 'create', daaScore: 1, status: 'confirmed', state: { status: 'open' } },
      { transactionId: 'join', daaScore: 2, status: 'confirmed', state: { status: 'joined' } },
    ],
    removedBlocks: ['join'],
  });
  assert.deepEqual(result.state, { status: 'open' });
});

test('adapter-facing reconstruction accepts a history envelope', () => {
  const result = reconstructGameState({ events: [{ transactionId: 'tx', status: 'confirmed', state: { status: 'open' } }] });
  assert.deepEqual(result.state, { status: 'open' });
  assert.equal(result.status, 'confirmed');
});

test('recovery stores never persist secrets and JSON storage survives reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keo-recovery-'));
  const filePath = join(directory, 'recovery.json');
  const record = { key: 'game', preparedHash: 'aa'.repeat(32), nonceHex: 'bb'.repeat(32), nested: { privateKey: 'secret' } };
  assert.equal(sanitizeRecord(record).nonceHex, undefined);
  const store = new JsonRecoveryStore(filePath);
  await store.save(record);
  assert.equal((await store.load('game')).preparedHash, record.preparedHash);
  assert.doesNotMatch(await readFile(filePath, 'utf8'), /nonceHex|privateKey|secret/);
  const memory = new MemoryRecoveryStore([record]);
  assert.equal((await memory.load('game')).preparedHash, record.preparedHash);
});

test('wallet changes notify the application so permissions can be cleared', async () => {
  const listeners = new Map();
  const provider = {
    requestAccounts: async () => ['kaspatest:player'],
    getPublicKey: async () => 'ab'.repeat(32),
    getNetwork: async () => 'kaspa_testnet_10',
    getAccounts: async () => ['kaspatest:player'],
    signPskt: async () => '{}',
    on: (event, listener) => listeners.set(event, listener),
    removeListener: () => {},
  };
  const changes = [];
  const wallet = new KaswareWalletAdapter(provider, { onChange: (change) => changes.push(change) });
  await wallet.connect();
  listeners.get('accountsChanged')(['kaspatest:other']);
  assert.deepEqual(changes, [{ reason: 'account', account: null, network: null }]);
  await assert.rejects(() => wallet.sign({ network: 'testnet-10', creatorAddress: 'kaspatest:player', txJson: '{}', preparedHash: 'aa' }), { code: 'WALLET_CHANGED' });
});

test('recovery projection fails closed and logs only safe fields', () => {
  assert.equal(projectRecoveryState({ status: 'loading' }).status, 'loading');
  assert.equal(projectRecoveryState({ status: 'empty' }).status, 'empty');
  const blocked = projectRecoveryState({ status: 'unknown', state: { permittedAction: 'settle' } });
  assert.equal(blocked.permittedAction, null);
  const entries = [];
  createRecoveryLogger({ info: (entry) => entries.push(entry), warn: () => {} }).transaction({
    transactionId: 'aa'.repeat(32), action: 'reveal', phase: 'joined', status: 'confirmed', nonceHex: 'bb'.repeat(32), commitment: 'cc'.repeat(32),
  });
   assert.deepEqual(entries[0], { transactionId: 'aa'.repeat(32), action: 'reveal', protocolVersion: 'EO/v6', templateHash: undefined, phase: 'joined', confirmationStatus: 'confirmed' });
  assert.doesNotMatch(JSON.stringify(entries), /bb|cc/);
});

test('recovery checkpoints authoritative state and reloads after a wallet change', async () => {
  const store = new MemoryRecoveryStore();
  const chain = { readGameState: async () => ({ confirmationStatus: 'confirmed', status: 'open', checkpoint: { daaScore: '7' } }) };
  const view = await recoverAndCheckpoint({ chain, store, gameId: 'aa'.repeat(32) });
  assert.equal(view.status, 'confirmed');
  assert.equal((await store.load('EO/v6\u0000recovery\u0000testnet-10\u0000' + 'aa'.repeat(32))).checkpoint.daaScore, '7');
  const events = [];
  const unsubscribe = bindWalletRecovery({ subscribe: (listener) => { events.push(listener); return () => {}; } }, (event) => events.push(event));
  events[0]({ reason: 'network' });
  assert.equal(events[1].reason, 'network');
  unsubscribe();
});
