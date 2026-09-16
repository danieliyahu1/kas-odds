import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameService } from '../src/backend-game-service.js';
import { BackendGameStore } from '../src/backend-game-store.js';
import { Metrics } from '../src/metrics.js';
import { prepareCreateGame } from '../src/create-game.js';

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
  assert.equal(status.protocolVersion, 'EO/v10');
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

test('reconciles a broadcast operation after game persistence failed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-reconcile-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(join(directory, 'games.json'));
  const transactionId = 'a'.repeat(64);
  const preparedHash = 'b'.repeat(64);
  await store.savePrepared({ preparedHash, request: { creatorAddress: 'kaspatest:creator' }, prepared: { txJson: '{}' }, createdAt: '2026-01-01T00:00:00.000Z' });
  await store.saveOperation({ operationId: `EO/v10\u0000submission\u0000creation\u0000${preparedHash}`, action: 'creation', gameId: transactionId, preparedHash, transactionId, status: 'broadcast', createdAt: '2026-01-01T00:00:00.000Z', metadata: {} });
  const service = new BackendGameService({ rpc: {}, store, gameFeePublicKey: GAME_FEE_PUBLIC_KEY });
  assert.equal(await service.reconcilePendingSubmissions(), 1);
  const game = await store.loadGame(transactionId);
  assert.equal(game.status, 'broadcast');
  assert.equal(game.creationPreparedHash, preparedHash);
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

test('creator cancel is available immediately for an unmatched open game', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gameId = 'ff'.repeat(32);
  const creatorAddress = 'kaspatest:creator';
  const creatorPublicKey = 'aa'.repeat(32);
  const request = prepareCreateGame({
    network: 'testnet-10',
    creatorAddress,
    creatorPublicKey,
    creatorCommitment: 'cc'.repeat(32),
    deadlineDaa: 10_000n,
    side: 'even',
    stakeKas: 1,
    feeSompi: 1_000n,
    gameFeePublicKey: GAME_FEE_PUBLIC_KEY,
  });
  const serializedRequest = Object.fromEntries(Object.entries(request).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]));
  const openRecord = {
    gameId,
    protocolVersion: 'EO/v10',
    status: 'waiting_for_player_b',
    request: serializedRequest,
    prepared: {
      network: 'testnet-10',
      creatorAddress,
      txJson: '{}',
      preparedHash: '07'.repeat(32),
      policy: {},
      feeSompi: '1000',
      covenantId: '03'.repeat(32),
      scriptPublicKey: request.covenantScriptPublicKey,
    },
    createdAt: new Date().toISOString(),
  };
  const covenantUtxo = {
    outpoint: { transactionId: gameId, index: 0 },
    amount: '100000000',
    scriptPublicKey: request.covenantScriptPublicKey,
    blockDaaScore: 50,
    isCoinbase: false,
  };
  const rpc = {
    getBlockDagInfo: async () => ({ virtualDaaScore: '100' }),
    getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
    getUtxosByAddresses: async (addresses) => {
      const [address] = addresses;
      if (address === request.covenantAddress) return { entries: [covenantUtxo] };
      return { entries: [] };
    },
  };
  const store = new BackendGameStore(join(directory, 'games.json'));
  await store.saveGame(openRecord);
  const service = new BackendGameService({ rpc, store, gameFeePublicKey: GAME_FEE_PUBLIC_KEY });

  // The open game is cancellable before its 5-minute deadline and the automatic
  // refund is not ready yet.
  const game = await service.readGame(gameId);
  assert.equal(game.status, 'waiting_for_player_b');
  assert.equal(game.canCancel, true);
  assert.equal(game.canJoin, true);
  assert.equal(game.automaticAction, 'refund_open');
  assert.equal(game.automaticReady, false);
  assert.equal(game.confirmationStatus, 'confirmed');

  // The creator's cancel is no longer blocked by the deadline: preparation
  // proceeds past the open-covenant check and fails only on wallet funding.
  await assert.rejects(
    service.prepareSafetyAction(gameId, 'creator_refund', { playerAddress: creatorAddress, playerPublicKey: creatorPublicKey }),
    { code: 'NO_UTXOS' },
  );

  // Only the creator may cancel an unmatched game.
  await assert.rejects(
    service.prepareSafetyAction(gameId, 'creator_refund', { playerAddress: 'kaspatest:joiner', playerPublicKey: 'bb'.repeat(32) }),
    { code: 'NOT_A_PLAYER' },
  );

  // Once Player B joins, cancel is unavailable.
  const joinedRecord = {
    ...openRecord,
    gameId: 'ee'.repeat(32),
    status: 'joined',
    join: {
      transactionId: 'dd'.repeat(32),
      preparedHash: '01'.repeat(32),
      joinerAddress: 'kaspatest:joiner',
      joinerPublicKey: 'bb'.repeat(32),
      joinerCommitment: 'ee'.repeat(32),
      joinedAddress: 'kaspatest:joined',
      joinedScriptPublicKey: '0000aa20' + '02'.repeat(32) + '87',
      joinedRedeemScript: 'ab'.repeat(32),
      covenantId: '03'.repeat(32),
      submittedAt: new Date().toISOString(),
    },
  };
  await store.saveGame(joinedRecord);
  await assert.rejects(
    service.prepareSafetyAction('ee'.repeat(32), 'creator_refund', { playerAddress: creatorAddress, playerPublicKey: creatorPublicKey }),
    { code: 'ACTION_UNAVAILABLE' },
  );
});

test('automatic settlement retries a rejected refund instead of abandoning it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gameId = 'ab'.repeat(32);
  const deadlineDaa = 10_000n;
  const request = prepareCreateGame({
    network: 'testnet-10',
    creatorAddress: 'kaspatest:creator',
    creatorPublicKey: 'aa'.repeat(32),
    creatorCommitment: 'cc'.repeat(32),
    deadlineDaa,
    side: 'even',
    stakeKas: 1,
    feeSompi: 1_000n,
    gameFeePublicKey: GAME_FEE_PUBLIC_KEY,
  });
  const serializedRequest = Object.fromEntries(Object.entries(request).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]));
  const openRecord = {
    gameId,
    protocolVersion: 'EO/v10',
    status: 'waiting_for_player_b',
    request: serializedRequest,
    prepared: {
      network: 'testnet-10',
      creatorAddress: 'kaspatest:creator',
      txJson: '{}',
      preparedHash: '07'.repeat(32),
      policy: {},
      feeSompi: '1000',
      covenantId: '03'.repeat(32),
      scriptPublicKey: request.covenantScriptPublicKey,
    },
    createdAt: new Date().toISOString(),
  };
  const covenantUtxo = {
    outpoint: { transactionId: gameId, index: 0 },
    amount: '100000000',
    scriptPublicKey: request.covenantScriptPublicKey,
    blockDaaScore: Number(deadlineDaa - 29n),
    isCoinbase: false,
  };
  // The node rejects the first broadcast as a transient condition does; the
  // keeper must try again on its next pass rather than abandon the refund.
  let broadcasts = 0;
  const rpc = {
    getBlockDagInfo: async () => ({ virtualDaaScore: String(deadlineDaa + 5n) }),
    getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
    getUtxosByAddresses: async (addresses) => {
      const [address] = addresses;
      return address === request.covenantAddress ? { entries: [covenantUtxo] } : { entries: [] };
    },
    submitSafeJson: async () => {
      broadcasts += 1;
      if (broadcasts === 1) throw new Error('temporarily unavailable');
      return 'cd'.repeat(32);
    },
  };
  const store = new BackendGameStore(join(directory, 'games.json'));
  await store.saveGame(openRecord);
  const service = new BackendGameService({ rpc, store, gameFeePublicKey: GAME_FEE_PUBLIC_KEY });

  await service.settleAutomaticGames();
  assert.equal(broadcasts, 1);
  assert.equal((await store.loadGame(gameId)).status, 'waiting_for_player_b', 'a rejected broadcast must not be recorded as settled');

  await service.settleAutomaticGames();
  const settled = await store.loadGame(gameId);
  assert.equal(broadcasts, 2, 'the keeper must retry a rejection rather than give up');
  assert.equal(settled.status, 'refund_open_broadcast');
  assert.equal(settled.automaticSettlement?.action, 'refund_open');
  assert.equal(settled.automaticSettlement?.status, 'broadcast');
});

async function matchRoles(service, matchId) {
  const firstView = await service.matchmakingStatus(matchId, 'kaspatest:first');
  const creatorAddress = firstView.role === 'creator' ? 'kaspatest:first' : 'kaspatest:second';
  const joinerAddress = creatorAddress === 'kaspatest:first' ? 'kaspatest:second' : 'kaspatest:first';
  const creatorPublicKey = creatorAddress === 'kaspatest:first' ? 'a'.repeat(64) : 'b'.repeat(64);
  const creatorView = await service.matchmakingStatus(matchId, creatorAddress);
  return { creatorAddress, joinerAddress, creatorPublicKey, creatorView };
}
