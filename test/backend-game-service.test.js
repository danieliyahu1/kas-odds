import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameService } from '../src/backend-game-service.js';
import { BackendGameStore } from '../src/backend-game-store.js';
import { Metrics } from '../src/metrics.js';
import { normalizePublicKey, prepareCreateGame } from '../src/create-game.js';
import { createRevealSecret } from '../src/reveal.js';
import { PROTOCOL_VERSION, UNCONFIRMED_INPUT_DAA_SCORE } from '../src/protocol.js';

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
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-service-'));
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
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-service-'));
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
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-service-'));
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

test('a friend room pairs the invited wallets at the host stake and assigned sides', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-room-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService({ rpc: NO_UTXO_RPC, store: new BackendGameStore(join(directory, 'games.json')), gameFeePublicKey: GAME_FEE_PUBLIC_KEY });

  const host = await service.createRoom({ address: 'kaspatest:host', publicKey: 'a'.repeat(64), stakeKas: 6 });
  assert.equal(host.status, 'waiting');
  assert.equal(host.role, null);
  assert.equal(host.stakeKas, 6);

  const friend = await service.joinRoom(host.matchId, { address: 'kaspatest:friend', publicKey: 'b'.repeat(64) });
  assert.equal(friend.status, 'matched');
  assert.equal(friend.opponentConnected, true);
  assert.equal(friend.stakeKas, 6);
  assert.equal(friend.role, 'joiner');

  // Reconnecting is idempotent, and the seat is single-use.
  assert.equal((await service.joinRoom(host.matchId, { address: 'kaspatest:friend', publicKey: 'b'.repeat(64) })).matchId, host.matchId);
  await assert.rejects(service.joinRoom(host.matchId, { address: 'kaspatest:third', publicKey: 'c'.repeat(64) }), { code: 'MATCH_FULL' });
  await assert.rejects(service.createRoom({ address: 'kaspatest:host', publicKey: 'a'.repeat(64), stakeKas: 0 }), { code: 'INVALID_STAKE' });

  // Only the host creates, using the room's fixed stake and assigned side.
  const hostView = await service.matchmakingStatus(host.matchId, 'kaspatest:host');
  assert.equal(hostView.role, 'creator');
  assert.notEqual(hostView.side, friend.side);
  const base = { matchId: host.matchId, creatorAddress: 'kaspatest:host', creatorPublicKey: 'a'.repeat(64), creatorCommitment: 'e'.repeat(64), side: hostView.side, stakeKas: 6 };
  await assert.rejects(service.prepareCreation({ ...base, stakeKas: 7 }), { code: 'MATCH_NOT_READY' });
  await assert.rejects(service.prepareCreation({ ...base, creatorAddress: 'kaspatest:friend' }), { code: 'MATCH_NOT_READY' });
  await assert.rejects(service.prepareCreation(base), { code: 'NO_UTXOS' });
});

test('preparing a game without a configured fee recipient fails cleanly', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-service-'));
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
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new BackendGameService(serviceOptions(new BackendGameStore(join(directory, 'games.json'))));
  await assert.rejects(
    service.submitCreation({ preparedHash: 'ab'.repeat(32), signedTxJson: '{}', matchId: null }),
    { code: 'PREPARATION_NOT_FOUND' },
  );
});

test('join, reveal, and read require an existing game', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-service-'));
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
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-service-'));
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
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-gateway-'));
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
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-service-'));
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
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-reconcile-'));
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
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(join(directory, 'games.json'));
  const metrics = new Metrics();
  const service = new BackendGameService({ rpc: {}, store, metrics, gameFeePublicKey: GAME_FEE_PUBLIC_KEY });
  await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64) });
  await service.refreshTelemetry();

  const text = metrics.render();
  assert.match(text, /kasodds_matchmaking_waiting 1/);
  assert.doesNotMatch(text, /kaspa_games_total/);
});

test('creator cancel is available immediately for an unmatched open game', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-cancel-'));
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
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-retry-'));
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

test('retries a transient orphan rejection within the same submission pass', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-orphan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gameId = 'ac'.repeat(32);
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
  const serialized = Object.fromEntries(Object.entries(request).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]));
  const openRecord = {
    gameId,
    protocolVersion: 'EO/v10',
    status: 'waiting_for_player_b',
    request: serialized,
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
  // The node rejects the first broadcast because the parent is not anchored yet;
  // the very next attempt, within the same pass, must be accepted.
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
      if (broadcasts === 1) {
        const error = new Error('RPC Server (remote error) -> Rejected transaction: transaction is an orphan where orphan is disallowed');
        error.code = 'TRANSACTION_REJECTED';
        error.cause = new Error('transaction is an orphan where orphan is disallowed');
        throw error;
      }
      return 'cd'.repeat(32);
    },
  };
  const store = new BackendGameStore(join(directory, 'games.json'));
  await store.saveGame(openRecord);
  const service = new BackendGameService({ rpc, store, gameFeePublicKey: GAME_FEE_PUBLIC_KEY, submissionRetryBaseMs: 1 });

  await service.settleAutomaticGames();
  assert.equal(broadcasts, 2, 'the orphan rejection is retried without reaching the player');
  const settled = await store.loadGame(gameId);
  assert.equal(settled.status, 'refund_open_broadcast');
  assert.equal(settled.automaticSettlement?.status, 'broadcast');
});

test('prepares a join against the creator output while the creation is unconfirmed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-join-prep-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gameId = 'a1'.repeat(32);
  const request = prepareCreateGame({
    network: 'testnet-10',
    creatorAddress: 'kaspatest:creator',
    creatorPublicKey: 'aa'.repeat(32),
    creatorCommitment: 'cc'.repeat(32),
    deadlineDaa: 10_000n,
    side: 'even',
    stakeKas: 1,
    feeSompi: 1_000n,
    gameFeePublicKey: GAME_FEE_PUBLIC_KEY,
  });
  const store = new BackendGameStore(join(directory, 'games.json'));
  await store.saveGame(unconfirmedGameRecord({ gameId, request }));
  await store.saveOperation(creationOperation(gameId, '07'.repeat(32), 'broadcast'));
  let captured;
  const joinTxJson = JSON.stringify({
    inputs: [{ transactionId: gameId, index: 0, sequence: '0', signatureScript: 'aa', utxo: { amount: '100000000', scriptPublicKey: request.covenantScriptPublicKey, blockDaaScore: String(UNCONFIRMED_INPUT_DAA_SCORE), covenantId: '03'.repeat(32) } }],
    outputs: [{ value: '200000000', scriptPublicKey: '00', covenant: null }],
  });
  const chain = {
    getCurrentDaaScore: async () => 500n,
    getUtxos: async () => { throw new Error('prepareJoin must not read the confirmed covenant UTXO'); },
    prepareJoin: async ({ game }) => {
      captured = game;
      return { txJson: joinTxJson, preparedHash: 'ab'.repeat(32), feeSompi: 0n, feerate: 1 };
    },
  };
  const service = new BackendGameService({ chain, store, gameFeePublicKey: GAME_FEE_PUBLIC_KEY });

  const result = await service.prepareJoin(gameId, { joinerAddress: 'kaspatest:joiner', joinerPublicKey: 'bb'.repeat(32), joinerCommitment: 'dd'.repeat(32) });

  assert.equal(result.gameId, gameId);
  assert.equal(captured.currentInput.transactionId, gameId);
  assert.equal(captured.currentInput.amount, 100_000_000n);
  assert.equal(captured.currentInput.scriptPublicKey, request.covenantScriptPublicKey);
  assert.equal(captured.currentInput.covenantId, '03'.repeat(32));
  assert.equal(captured.currentInput.redeemScript, request.covenantRedeemScript, 'the covenant input must carry its redeem script for the P2SH signature script');
  assert.equal(captured.currentInput.blockDaaScore, UNCONFIRMED_INPUT_DAA_SCORE, 'the parent must be described as not yet mined');
  assert.equal(captured.currentCovenantId, '03'.repeat(32));
});

test('a join is gated on its creation reaching the network', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-join-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gameId = 'a2'.repeat(32);
  const request = prepareCreateGame({
    network: 'testnet-10',
    creatorAddress: 'kaspatest:creator',
    creatorPublicKey: 'aa'.repeat(32),
    creatorCommitment: 'cc'.repeat(32),
    deadlineDaa: 10_000n,
    side: 'even',
    stakeKas: 1,
    feeSompi: 1_000n,
    gameFeePublicKey: GAME_FEE_PUBLIC_KEY,
  });
  const store = new BackendGameStore(join(directory, 'games.json'));
  await store.saveGame(unconfirmedGameRecord({ gameId, request }));
  const chain = {
    getCurrentDaaScore: async () => 500n,
    getUtxos: async () => ({ entries: [] }),
    prepareJoin: async () => ({ txJson: '{}', preparedHash: 'ab'.repeat(32), feeSompi: 0n, feerate: 1 }),
  };
  const service = new BackendGameService({ chain, store, gameFeePublicKey: GAME_FEE_PUBLIC_KEY });
  const joiner = { joinerAddress: 'kaspatest:joiner', joinerPublicKey: 'bb'.repeat(32), joinerCommitment: 'dd'.repeat(32) };
  await store.saveJoinPrepared({
    preparedHash: 'ab'.repeat(32), gameId, joinerAddress: joiner.joinerAddress, joinerPublicKey: joiner.joinerPublicKey,
    joinerCommitment: joiner.joinerCommitment, txJson: '{}', feeSompi: '0', priorityFeerate: 1,
    joinedAddress: 'kaspatest:joined', joinedScriptPublicKey: '00', joinedRedeemScript: '00', covenantId: '03'.repeat(32), createdAt: new Date().toISOString(),
  });

  await store.saveOperation(creationOperation(gameId, '07'.repeat(32), 'failed'));
  await assert.rejects(service.prepareJoin(gameId, joiner), { code: 'CREATION_FAILED' });
  await assert.rejects(service.submitJoin(gameId, { preparedHash: 'ab'.repeat(32), signedTxJson: '{}' }), { code: 'CREATION_FAILED' });

  await store.saveOperation(creationOperation(gameId, '07'.repeat(32), 'submitting'));
  await assert.rejects(service.prepareJoin(gameId, joiner), { code: 'CREATION_PENDING' });
});

test('a prepared join for a re-signed creation is rejected', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-join-stale-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const gameIdA = 'a3'.repeat(32);
  const gameIdB = 'b3'.repeat(32);
  const matchId = 'c3'.repeat(32);
  const request = prepareCreateGame({
    network: 'testnet-10',
    creatorAddress: 'kaspatest:creator',
    creatorPublicKey: 'aa'.repeat(32),
    creatorCommitment: 'cc'.repeat(32),
    deadlineDaa: 10_000n,
    side: 'even',
    stakeKas: 1,
    feeSompi: 1_000n,
    gameFeePublicKey: GAME_FEE_PUBLIC_KEY,
  });
  const store = new BackendGameStore(join(directory, 'games.json'));
  await store.saveGame(unconfirmedGameRecord({ gameId: gameIdA, request, matchId }));
  await store.saveOperation(creationOperation(gameIdA, '07'.repeat(32), 'broadcast'));
  await store.saveMatch({
    matchId, status: 'started', gameId: gameIdB, creatorIndex: 0, creatorSide: 'even', stakeKas: 1,
    players: [{ address: 'kaspatest:creator', publicKey: 'aa'.repeat(32), limitKas: 1 }, { address: 'kaspatest:joiner', publicKey: 'bb'.repeat(32), limitKas: 1 }],
  });
  await store.saveJoinPrepared({
    preparedHash: 'ab'.repeat(32), gameId: gameIdA, matchId, joinerAddress: 'kaspatest:joiner', joinerPublicKey: 'bb'.repeat(32),
    joinerCommitment: 'dd'.repeat(32), txJson: '{}', feeSompi: '0', priorityFeerate: 1,
    joinedAddress: 'kaspatest:joined', joinedScriptPublicKey: '00', joinedRedeemScript: '00', covenantId: '03'.repeat(32), createdAt: new Date().toISOString(),
  });
  const chain = {
    getCurrentDaaScore: async () => 500n,
    getUtxos: async () => ({ entries: [] }),
    prepareJoin: async () => ({ txJson: '{}', preparedHash: 'ab'.repeat(32), feeSompi: 0n, feerate: 1 }),
  };
  const service = new BackendGameService({ chain, store, gameFeePublicKey: GAME_FEE_PUBLIC_KEY });

  await assert.rejects(service.submitJoin(gameIdA, { preparedHash: 'ab'.repeat(32), signedTxJson: '{}' }), { code: 'MATCH_NOT_READY' });
});

function serializedRequest(request) {
  return Object.fromEntries(Object.entries(request).map(([key, value]) => [key, typeof value === 'bigint' ? String(value) : value]));
}

test('matchmaking pairs, waits, and misses are logged without wallet addresses', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-mm-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const log = { info: (event, fields) => events.push({ event, fields }), warn: () => {}, error: () => {}, debug: () => {} };
  const service = new BackendGameService({ ...serviceOptions(new BackendGameStore(join(directory, 'games.json'))), log });

  const first = await service.joinMatchmaking({ address: 'kaspatest:first', publicKey: 'a'.repeat(64), limitKas: 5 });
  const second = await service.joinMatchmaking({ address: 'kaspatest:second', publicKey: 'b'.repeat(64), limitKas: 5 });
  assert.equal(first.matchId, second.matchId);
  assert.deepEqual(events.find((entry) => entry.event === 'matchmaking_waiting'), { event: 'matchmaking_waiting', fields: { matchId: first.matchId, limitKas: 5 } });
  assert.deepEqual(events.find((entry) => entry.event === 'matchmaking_paired').fields, { matchId: second.matchId, stakeKas: 5 });

  await assert.rejects(service.matchmakingStatus(second.matchId, 'kaspatest:stranger'), { code: 'NOT_A_PLAYER' });
  assert.deepEqual(events.find((entry) => entry.event === 'matchmaking_status_miss'), { event: 'matchmaking_status_miss', fields: { matchId: second.matchId, reason: 'NOT_A_PLAYER' } });
  assert.doesNotMatch(JSON.stringify(events), /kaspatest/);
});

function unconfirmedGameRecord({ gameId, request, preparedHash = '07'.repeat(32), covenantId = '03'.repeat(32), matchId }) {
  return {
    gameId,
    network: 'testnet-10',
    protocolVersion: PROTOCOL_VERSION,
    status: 'broadcast',
    request: serializedRequest(request),
    prepared: { network: 'testnet-10', creatorAddress: request.creatorAddress, txJson: '{}', preparedHash, policy: {}, feeSompi: '1000', covenantId, scriptPublicKey: request.covenantScriptPublicKey },
    creationPreparedHash: preparedHash,
    ...(matchId ? { matchId } : {}),
    createdAt: new Date().toISOString(),
  };
}

function creationOperation(gameId, preparedHash, status) {
  return { operationId: `${PROTOCOL_VERSION}\u0000submission\u0000creation\u0000${preparedHash}`, action: 'creation', gameId, preparedHash, transactionId: gameId, status, createdAt: new Date().toISOString(), metadata: {} };
}

async function matchRoles(service, matchId) {
  const firstView = await service.matchmakingStatus(matchId, 'kaspatest:first');
  const creatorAddress = firstView.role === 'creator' ? 'kaspatest:first' : 'kaspatest:second';
  const joinerAddress = creatorAddress === 'kaspatest:first' ? 'kaspatest:second' : 'kaspatest:first';
  const creatorPublicKey = creatorAddress === 'kaspatest:first' ? 'a'.repeat(64) : 'b'.repeat(64);
  const creatorView = await service.matchmakingStatus(matchId, creatorAddress);
  return { creatorAddress, joinerAddress, creatorPublicKey, creatorView };
}

// --- Serialized reveal ordering -------------------------------------------

const REVEAL_GAME_ID = 'ff'.repeat(32);
const REVEAL_CREATOR_ADDRESS = 'kaspatest:creator';
const REVEAL_JOINER_ADDRESS = 'kaspatest:joiner';
const REVEAL_CREATOR_PUBLIC_KEY = 'aa'.repeat(32);
const REVEAL_JOINER_PUBLIC_KEY = 'bb'.repeat(32);
const REVEAL_JOIN_TXID = 'dd'.repeat(32);
const REVEAL_LEAD_TXID = 'ee'.repeat(32);
const REVEAL_JOINED_ADDRESS = 'kaspatest:joined';
const REVEAL_JOINED_SPK = '0000aa20' + '02'.repeat(32) + '87';
const REVEAL_CONTINUATION_ADDRESS = 'kaspatest:continuation';
const REVEAL_CONTINUATION_SPK = '0000aa20' + '05'.repeat(32) + '87';
const REVEAL_GROSS_POT = '200000000';
const creatorRevealSecret = createRevealSecret({ gameId: REVEAL_GAME_ID, player: 'creator', choice: 1, nonce: new Uint8Array(32).fill(7) });
const joinerRevealSecret = createRevealSecret({ gameId: REVEAL_GAME_ID, player: 'joiner', choice: 0, nonce: new Uint8Array(32).fill(8) });

function revealGameRecord(reveals = []) {
  const request = prepareCreateGame({
    network: 'testnet-10',
    creatorAddress: REVEAL_CREATOR_ADDRESS,
    creatorPublicKey: REVEAL_CREATOR_PUBLIC_KEY,
    creatorCommitment: creatorRevealSecret.commitment,
    deadlineDaa: 10_000n,
    side: 'even',
    stakeKas: 1,
    feeSompi: 1_000n,
    gameFeePublicKey: GAME_FEE_PUBLIC_KEY,
  });
  return {
    gameId: REVEAL_GAME_ID,
    protocolVersion: PROTOCOL_VERSION,
    status: 'joined',
    request: serializedRequest(request),
    join: {
      transactionId: REVEAL_JOIN_TXID,
      joinerAddress: REVEAL_JOINER_ADDRESS,
      joinerPublicKey: REVEAL_JOINER_PUBLIC_KEY,
      joinerCommitment: joinerRevealSecret.commitment,
      joinedAddress: REVEAL_JOINED_ADDRESS,
      joinedScriptPublicKey: REVEAL_JOINED_SPK,
      joinedRedeemScript: 'ab'.repeat(32),
      covenantId: '03'.repeat(32),
      submittedAt: new Date().toISOString(),
    },
    ...(reveals.length > 0 ? { reveals } : {}),
  };
}

function leadReveal(overrides = {}) {
  return {
    transactionId: REVEAL_LEAD_TXID,
    preparedHash: '04'.repeat(32),
    playerAddress: REVEAL_CREATOR_ADDRESS,
    role: 'creator',
    choice: creatorRevealSecret.choice,
    status: 'broadcast',
    continuationAddress: REVEAL_CONTINUATION_ADDRESS,
    continuationScriptPublicKey: REVEAL_CONTINUATION_SPK,
    continuationRedeemScript: '06'.repeat(32),
    winner: null,
    submittedAt: new Date().toISOString(),
    ...overrides,
  };
}

function revealFunding() {
  return { outpoint: { transactionId: '77'.repeat(32), index: 0 }, amount: '2535839900', scriptPublicKey: `000020${'88'.repeat(32)}ac`, blockDaaScore: 100, isCoinbase: false };
}

function revealRpc({ escrow = true, continuation = null, funding = [] } = {}) {
  return {
    getBlockDagInfo: async () => ({ virtualDaaScore: '3000' }),
    getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
    getUtxosByAddresses: async (addresses) => {
      const [address] = addresses;
      if (address === REVEAL_JOINED_ADDRESS && escrow) {
        return { entries: [{ outpoint: { transactionId: REVEAL_JOIN_TXID, index: 0 }, amount: REVEAL_GROSS_POT, scriptPublicKey: REVEAL_JOINED_SPK, blockDaaScore: 100, isCoinbase: false }] };
      }
      if (address === REVEAL_CONTINUATION_ADDRESS && continuation) return { entries: [continuation] };
      return { entries: funding };
    },
  };
}

async function revealService(t, { reveals = [], rpcOptions } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-reveal-order-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(join(directory, 'games.json'));
  await store.saveGame(revealGameRecord(reveals));
  return new BackendGameService({ rpc: revealRpc(rpcOptions), store, gameFeePublicKey: GAME_FEE_PUBLIC_KEY });
}

function joinerReveal(service) {
  return service.prepareReveal(REVEAL_GAME_ID, {
    playerAddress: REVEAL_JOINER_ADDRESS,
    playerPublicKey: normalizePublicKey(REVEAL_JOINER_PUBLIC_KEY),
    choice: joinerRevealSecret.choice,
    nonceHex: joinerRevealSecret.nonceHex,
  });
}

// The exact regression from the field: the second player pressed Reveal while the
// first reveal was already broadcast. It must wait for that lead; it must never
// look for the joined escrow the lead already spent.
test('a second reveal waits while the rival lead is unconfirmed', async (t) => {
  const service = await revealService(t, { reveals: [leadReveal()], rpcOptions: { escrow: false } });
  await assert.rejects(joinerReveal(service), { code: 'REVEAL_WAITING' });
});

test('two lead preparations at once let only the first player lead', async (t) => {
  const service = await revealService(t, { rpcOptions: { funding: [revealFunding()] } });
  const prepared = await service.prepareReveal(REVEAL_GAME_ID, {
    playerAddress: REVEAL_CREATOR_ADDRESS,
    playerPublicKey: normalizePublicKey(REVEAL_CREATOR_PUBLIC_KEY),
    choice: creatorRevealSecret.choice,
    nonceHex: creatorRevealSecret.nonceHex,
  });
  assert.equal(prepared.stage, 'first_reveal');
  await assert.rejects(joinerReveal(service), { code: 'REVEAL_WAITING' });
});

test('the second player settles once the lead reveal confirms', async (t) => {
  const continuation = { outpoint: { transactionId: REVEAL_LEAD_TXID, index: 0 }, amount: REVEAL_GROSS_POT, scriptPublicKey: REVEAL_CONTINUATION_SPK, blockDaaScore: 1999, isCoinbase: false };
  const service = await revealService(t, {
    reveals: [leadReveal({ status: 'confirmed', confirmedDaaScore: '2000' })],
    rpcOptions: { escrow: false, continuation, funding: [revealFunding()] },
  });
  const prepared = await joinerReveal(service);
  assert.equal(prepared.stage, 'settlement');
});
