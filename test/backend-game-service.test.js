import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameService } from '../src/backend-game-service.js';
import { BackendGameStore } from '../src/backend-game-store.js';
import { Metrics } from '../src/metrics.js';

const NO_UTXO_RPC = {
  getBlockDagInfo: async () => ({ virtualDaaScore: '100' }),
  getUtxosByAddresses: async () => ({ entries: [] }),
  getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
};

const GAME_FEE_PUBLIC_KEY = '11'.repeat(32);

function serviceOptions(store) {
  return { rpc: {}, store, gameFeePublicKey: GAME_FEE_PUBLIC_KEY };
}

test('matchmaking pairs wallets at the lower limit and assigns each a role and side', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService(serviceOptions(new BackendGameStore(join(directory, 'games.json'))));
  const first = await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64), limitKas: 10 });
  assert.equal(first.status, 'waiting');
  assert.equal(first.role, null);
  assert.equal(first.myLimitKas, 10);
  assert.equal(first.rivalLimitKas, null);
  const second = await service.joinMatchmaking({ address: 'kaspatest:second', publicKey: 'b'.repeat(64), limitKas: 3 });

  assert.equal(second.status, 'matched');
  assert.equal(second.stakeKas, 3);
  assert.equal(second.myLimitKas, 3);
  assert.equal(second.rivalLimitKas, 10);
  assert.equal(second.opponentConnected, true);
  assert.ok(['creator', 'joiner'].includes(second.role));
  assert.ok(['even', 'odd'].includes(second.side));

  const firstStatus = await service.matchmakingStatus(first.matchId, 'kaspatest:first');
  assert.equal(firstStatus.matchId, second.matchId);
  assert.equal(firstStatus.stakeKas, 3);
  assert.equal(firstStatus.role === 'creator' ? 'joiner' : 'creator', second.role);
});

test('only the match creator may start the game, with the assigned side and agreed stake', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService({ rpc: NO_UTXO_RPC, store: new BackendGameStore(join(directory, 'games.json')), gameFeePublicKey: GAME_FEE_PUBLIC_KEY });
  const first = await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64) });
  const matched = await service.joinMatchmaking({ address: 'kaspatest:second', publicKey: 'b'.repeat(64) });
  const stakeKas = matched.stakeKas;
  const { creatorAddress, joinerAddress, creatorPublicKey, creatorView } = await matchRoles(service, first.matchId);

  const base = { matchId: first.matchId, creatorAddress, creatorPublicKey, creatorCommitment: 'e'.repeat(64), side: creatorView.side, stakeKas };
  // The assigned creator is the only wallet that may sign the creation.
  await assert.rejects(service.prepareCreation({ ...base, creatorAddress: joinerAddress }), { code: 'MATCH_NOT_READY' });
  // The creator must use the assigned side.
  await assert.rejects(service.prepareCreation({ ...base, side: creatorView.side === 'even' ? 'odd' : 'even' }), { code: 'MATCH_NOT_READY' });
  // The creator must use the agreed stake.
  await assert.rejects(service.prepareCreation({ ...base, stakeKas: stakeKas + 1 }), { code: 'MATCH_NOT_READY' });
  // A valid creator request proceeds to chain work (empty wallet UTXOs).
  await assert.rejects(service.prepareCreation(base), { code: 'NO_UTXOS' });
});

test('stake acceptance requires an active pair and the agreed lower limit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService(serviceOptions(new BackendGameStore(join(directory, 'games.json'))));
  const first = await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64), limitKas: 4 });
  assert.equal(first.status, 'waiting');
  assert.equal(first.stakeKas, null);
  const second = await service.joinMatchmaking({ address: 'kaspatest:second', publicKey: 'b'.repeat(64), limitKas: 8 });
  assert.equal(second.stakeKas, 4);
  // Limits are validated as whole KAS amounts from 1 to 1,000,000.
  await assert.rejects(service.joinMatchmaking({ address: 'kaspatest:zero', publicKey: 'c'.repeat(64), limitKas: 0 }), { code: 'INVALID_STAKE' });
  await assert.rejects(service.joinMatchmaking({ address: 'kaspatest:huge', publicKey: 'd'.repeat(64), limitKas: 1_000_001 }), { code: 'INVALID_STAKE' });
});

test('preparing a game without a configured fee recipient fails cleanly', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService({ rpc: NO_UTXO_RPC, store: new BackendGameStore(join(directory, 'games.json')) });
  await assert.rejects(service.prepareCreation({
    creatorAddress: 'kaspatest:creator',
    creatorPublicKey: 'a'.repeat(64),
    creatorCommitment: 'e'.repeat(64),
    side: 'even',
    stakeKas: 1,
  }), { code: 'INVALID_GAME_FEE' });
});

test('submitting an unknown creation preparation is rejected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService(serviceOptions(new BackendGameStore(join(directory, 'games.json'))));
  await assert.rejects(
    service.submitCreation({ preparedHash: 'ab'.repeat(32), signedTxJson: '{}', matchId: null }),
    { code: 'PREPARATION_NOT_FOUND' },
  );
});

test('join, reveal, and read require an existing game', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService(serviceOptions(new BackendGameStore(join(directory, 'games.json'))));
  const gameId = 'f'.repeat(64);
  await assert.rejects(
    service.prepareJoin(gameId, { joinerAddress: 'kaspatest:x', joinerPublicKey: 'a'.repeat(64), joinerCommitment: 'b'.repeat(64) }),
    { code: 'GAME_NOT_FOUND' },
  );
  await assert.rejects(
    service.prepareReveal(gameId, { playerAddress: 'kaspatest:x', playerPublicKey: 'a'.repeat(64), choice: 1, nonceHex: 'c'.repeat(64) }),
    { code: 'GAME_NOT_JOINED' },
  );
  await assert.rejects(service.readGame(gameId), { code: 'GAME_NOT_FOUND' });
  await assert.rejects(
    service.prepareSafetyAction(gameId, 'refund_all', { playerAddress: 'kaspatest:x', playerPublicKey: 'a'.repeat(64) }),
    { code: 'GAME_NOT_FOUND' },
  );
});

test('network status is served without touching the node or exposing a browser wRPC URL', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rpc = { getBlockDagInfo: async () => { throw new Error('networkStatus must not query the node'); } };
  const service = new BackendGameService({ rpc, store: new BackendGameStore(join(directory, 'games.json')), gameFeePublicKey: GAME_FEE_PUBLIC_KEY });
  const status = await service.networkStatus();
  assert.equal(status.network, 'testnet-10');
  assert.equal(status.protocolVersion, 'EO/v9');
  assert.equal(status.gameFeePublicKey, GAME_FEE_PUBLIC_KEY);
  assert.equal(status.wrpcUrl, undefined);
});

test('application service uses the injected chain gateway instead of raw RPC', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-gateway-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let preparedRequest;
  const chain = {
    getCurrentDaaScore: async () => 100n,
    prepareCreation: async (request) => {
      preparedRequest = request;
      return {
        preparedHash: 'p'.repeat(64),
        txJson: JSON.stringify({ inputs: [], outputs: [] }),
        feeSompi: 0n,
        policy: { changeScriptPublicKey: 'change' },
        mass: 1,
        assumedSignedInputs: 0,
        feerate: 0,
      };
    },
  };
  const service = new BackendGameService({ chain, store: new BackendGameStore(join(directory, 'games.json')), gameFeePublicKey: GAME_FEE_PUBLIC_KEY });
  const result = await service.prepareCreation({
    creatorAddress: 'kaspatest:creator',
    creatorPublicKey: 'a'.repeat(64),
    creatorCommitment: 'e'.repeat(64),
    side: 'even',
    stakeKas: 1,
  });
  assert.equal(result.preparedHash, 'p'.repeat(64));
  assert.equal(preparedRequest.deadlineDaa, 100n + 3_000n);
});

test('automatic scheduler targets the open covenant deadline', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(join(directory, 'games.json'));
  await store.saveGame({
    gameId: 'a'.repeat(64),
    status: 'waiting_for_player_b',
    request: { stakeSompi: '100000000', feeSompi: '0', settleFeeSompi: '1600000', deadlineDaa: '1200' },
  });
  const service = new BackendGameService({
    rpc: { getBlockDagInfo: async () => ({ virtualDaaScore: '1000' }) },
    store,
    gameFeePublicKey: GAME_FEE_PUBLIC_KEY,
  });
  assert.equal(await service.automaticSettlementDelayMs(), 21_000);
});

test('refreshTelemetry publishes the matchmaking backlog gauge and no game-state gauge', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(join(directory, 'games.json'));
  const metrics = new Metrics();
  const service = new BackendGameService({ rpc: {}, store, metrics, gameFeePublicKey: GAME_FEE_PUBLIC_KEY });
  await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64) });
  await service.refreshTelemetry();

  const text = metrics.render();
  assert.match(text, /kaspa_matchmaking_waiting 1/);
  assert.doesNotMatch(text, /kaspa_games_total/);
});

async function matchRoles(service, matchId) {
  const firstView = await service.matchmakingStatus(matchId, 'kaspatest:first');
  const creatorAddress = firstView.role === 'creator' ? 'kaspatest:first' : 'kaspatest:second';
  const joinerAddress = creatorAddress === 'kaspatest:first' ? 'kaspatest:second' : 'kaspatest:first';
  const creatorPublicKey = creatorAddress === 'kaspatest:first' ? 'a'.repeat(64) : 'b'.repeat(64);
  const creatorView = await service.matchmakingStatus(matchId, creatorAddress);
  return { creatorAddress, joinerAddress, creatorPublicKey, creatorView };
}
