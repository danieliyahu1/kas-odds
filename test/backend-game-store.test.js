import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameStore } from '../src/backend-game-store.js';
import { GAME_RESULT_RETENTION_MS } from '../src/terminal-actions.js';

test('matchmaking pairs two wallets and keeps the queue private to the store', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-match-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(filePath);
  const first = await store.joinMatchmaking({ matchId: 'first-match', address: 'kaspatest:first', publicKey: 'a'.repeat(64), limitKas: 5 });
  assert.equal(first.status, 'waiting');
  assert.equal(first.players.length, 1);
  assert.equal(first.stakeKas, null);

  const second = await store.joinMatchmaking({ matchId: 'second-match', address: 'kaspatest:second', publicKey: 'b'.repeat(64), limitKas: 5 });
  assert.equal(second.status, 'matched');
  assert.equal(second.players.length, 2);
  assert.equal(second.stakeKas, 5);
  assert.ok(['even', 'odd'].includes(second.creatorSide));
  assert.ok([0, 1].includes(second.creatorIndex));
  assert.deepEqual((await store.loadMatch('first-match')).players.map(({ address }) => address), ['kaspatest:first', 'kaspatest:second']);

  await store.updateMatch('first-match', (match) => { match.status = 'started'; match.creation = { gameId: 'd'.repeat(64) }; });
  const updated = await store.loadMatch('first-match');
  assert.equal(updated.status, 'started');
  assert.equal(updated.creation.gameId, 'd'.repeat(64));

  await store.leaveMatch('first-match', 'kaspatest:first');
  assert.deepEqual((await store.loadMatch('first-match')).players.map(({ address }) => address), ['kaspatest:second']);
});

test('pairs any two waiters and stakes the lower limit', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-limit-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(filePath);

  const high = await store.joinMatchmaking({ matchId: 'high', address: 'kaspatest:high', publicKey: 'a'.repeat(64), limitKas: 20 });
  assert.equal(high.status, 'waiting');

  const low = await store.joinMatchmaking({ matchId: 'low', address: 'kaspatest:low', publicKey: 'b'.repeat(64), limitKas: 5 });
  assert.equal(low.status, 'matched');
  assert.equal(low.stakeKas, 5);
  assert.deepEqual(low.players.map((player) => player.limitKas), [20, 5]);

  const solo = await store.joinMatchmaking({ matchId: 'solo', address: 'kaspatest:solo', publicKey: 'c'.repeat(64), limitKas: 3 });
  assert.equal(solo.status, 'waiting');
  assert.equal(solo.stakeKas, null);
});

test('a private room holds a fixed stake and only the invited wallet may take the second seat', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-room-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(filePath);

  const room = await store.createPrivateMatch({ matchId: 'room', address: 'kaspatest:host', publicKey: 'a'.repeat(64), stakeKas: 7 });
  assert.equal(room.status, 'waiting');
  assert.equal(room.private, true);
  assert.equal(room.stakeKas, 7);
  assert.equal(room.players[0].limitKas, 7);
  // The room is never part of the public backlog.
  assert.equal(await store.countWaitingMatches(), 0);

  const joined = await store.joinPrivateMatch('room', { address: 'kaspatest:friend', publicKey: 'b'.repeat(64) });
  assert.equal(joined.status, 'matched');
  assert.equal(joined.creatorIndex, 0);
  assert.equal(joined.stakeKas, 7);
  assert.deepEqual(joined.players.map((player) => player.address), ['kaspatest:host', 'kaspatest:friend']);

  // Reconnecting the invited wallet is idempotent; a third wallet is refused.
  const reconnect = await store.joinPrivateMatch('room', { address: 'kaspatest:friend', publicKey: 'b'.repeat(64) });
  assert.equal(reconnect.players.length, 2);
  await assert.rejects(store.joinPrivateMatch('room', { address: 'kaspatest:third', publicKey: 'c'.repeat(64) }), { code: 'MATCH_FULL' });
  await assert.rejects(store.joinPrivateMatch('missing', { address: 'kaspatest:third', publicKey: 'c'.repeat(64) }), { code: 'MATCH_NOT_FOUND' });
});

test('a public waiter never fills a private room seat', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-room-queue-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(filePath);

  await store.createPrivateMatch({ matchId: 'room', address: 'kaspatest:host', publicKey: 'a'.repeat(64), stakeKas: 7 });
  const waiter = await store.joinMatchmaking({ matchId: 'waiter', address: 'kaspatest:waiter', publicKey: 'b'.repeat(64), limitKas: 9 });
  assert.equal(waiter.matchId, 'waiter');
  assert.equal(waiter.status, 'waiting');
  assert.equal((await store.loadMatch('room')).status, 'waiting');
});

test('an idle private room expires like a public session', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-room-idle-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(filePath);

  await store.createPrivateMatch({ matchId: 'idle', address: 'kaspatest:idle', publicKey: 'a'.repeat(64), stakeKas: 2 });
  await store.updateMatch('idle', (match) => { match.players[0].lastSeenAt = new Date(Date.now() - 60_000).toISOString(); });
  await store.createPrivateMatch({ matchId: 'fresh', address: 'kaspatest:fresh', publicKey: 'b'.repeat(64), stakeKas: 2 });
  assert.equal((await store.loadMatch('idle')).status, 'cancelled');
});

test('persists games and transaction preparations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-store-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(filePath);

  await store.savePrepared({ preparedHash: 'p1', request: { stakeSompi: '1' }, createdAt: 'now' });
  await store.saveJoinPrepared({ preparedHash: 'j1', gameId: 'g'.repeat(64) });
  await store.saveActionPrepared({ preparedHash: 'a1', action: 'refund_all' });
  await store.saveGame({ gameId: 'g'.repeat(64), status: 'broadcast' });

  assert.deepEqual(await store.loadPrepared('p1'), { preparedHash: 'p1', request: { stakeSompi: '1' }, createdAt: 'now' });
  assert.equal((await store.loadJoinPrepared('j1')).gameId, 'g'.repeat(64));
  assert.equal((await store.loadActionPrepared('a1')).action, 'refund_all');
  assert.equal((await store.loadGame('g'.repeat(64))).status, 'broadcast');
  assert.equal(await store.loadPrepared('missing'), null);
});

test('reloads stored data from disk after a new instance', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-store-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const first = new BackendGameStore(filePath);
  await first.saveGame({ gameId: 'a'.repeat(64), status: 'joined' });

  const second = new BackendGameStore(filePath);
  assert.equal((await second.loadGame('a'.repeat(64))).status, 'joined');
});

test('completing a game keeps its terminal record and drops the live aggregates', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-complete-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(filePath);
  const gameId = 'g'.repeat(64);
  const matchId = 'match';

  await store.savePrepared({ preparedHash: 'p1', prepared: { txJson: 'creation' } });
  await store.saveJoinPrepared({ preparedHash: 'j1', gameId });
  await store.saveActionPrepared({ preparedHash: 'a1', gameId });
  await store.saveGame({ gameId, matchId, creationPreparedHash: 'p1', prepared: { txJson: 'creation' }, status: 'settled' });
  await store.saveMatch({ matchId, status: 'started', players: [] });

  assert.equal(await store.completeGame({ gameId, matchId, creationPreparedHash: 'p1', prepared: { txJson: 'creation' }, status: 'settled', winner: 'creator' }), true);
  const retained = await store.loadGame(gameId);
  assert.equal(retained.status, 'settled');
  assert.equal(retained.winner, 'creator');
  assert.ok(retained.completedAt, 'the terminal record keeps a completion timestamp');
  assert.equal(await store.loadPrepared('p1'), null);
  assert.equal(await store.loadJoinPrepared('j1'), null);
  assert.equal(await store.loadActionPrepared('a1'), null);
  assert.equal(await store.loadMatch(matchId), null);
});

test('pruning removes finished games after the retrieval window but keeps live ones', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-complete-prune-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(filePath);
  const expired = 'e'.repeat(64);
  const recent = 'r'.repeat(64);
  const lively = 'l'.repeat(64);
  const old = new Date(Date.now() - GAME_RESULT_RETENTION_MS - 60_000).toISOString();

  await store.saveGame({ gameId: expired, status: 'settled', createdAt: old, completedAt: old });
  await store.saveGame({ gameId: recent, status: 'settled', createdAt: new Date().toISOString(), completedAt: new Date().toISOString() });
  await store.saveGame({ gameId: lively, status: 'joined', createdAt: old });

  await store.init();

  assert.equal(await store.loadGame(expired), null, 'a finished game past the window is removed');
  assert.ok(await store.loadGame(recent), 'a just-finished game is still readable');
  assert.ok(await store.loadGame(lively), 'an unfinished game is never pruned');
});

test('startup pruning removes expired durable preparations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-prune-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(filePath);
  await store.savePrepared({ preparedHash: 'old', createdAt: '2020-01-01T00:00:00.000Z' });
  await store.savePrepared({ preparedHash: 'new', createdAt: new Date().toISOString() });

  await store.init();

  assert.equal(await store.loadPrepared('old'), null);
  assert.ok(await store.loadPrepared('new'));
});

test('rejects malformed store JSON without replacing it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-corrupt-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'games.json');
  await writeFile(filePath, '{not json', 'utf8');
  await assert.rejects(() => new BackendGameStore(filePath).loadGame('missing'), { code: 'STORAGE_CORRUPT' });
  assert.equal(await readFile(filePath, 'utf8'), '{not json');
});

test('rejects malformed store schemas', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-schema-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'games.json');
  await writeFile(filePath, JSON.stringify({ games: [] }), 'utf8');
  await assert.rejects(() => new BackendGameStore(filePath).loadGame('missing'), { code: 'STORAGE_CORRUPT' });
});

test('preserves store path failures and their causes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-write-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(directory);
  await assert.rejects(() => store.saveGame({ gameId: 'g'.repeat(64) }), (error) => {
    assert.equal(error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(error.cause.code, 'EISDIR');
    return true;
  });
});

test('serializes concurrent store mutations and isolates returned clones', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-concurrent-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(join(directory, 'games.json'));
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.saveGame({ gameId: `${index}`.padStart(64, '0'), status: 'waiting' })));
  const games = await store.listGames();
  assert.equal(games.length, 20);
  games[0].status = 'mutated';
  assert.equal((await store.listGames())[0].status, 'waiting');
});

test('persists and reloads non-secret submission operations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-operations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(join(directory, 'games.json'));
  const operation = { operationId: 'operation-1', action: 'join', gameId: 'g'.repeat(64), preparedHash: 'p'.repeat(64), status: 'broadcast', transactionId: 't'.repeat(64), metadata: { joinerAddress: 'kaspatest:joiner' } };
  await store.saveOperation(operation);
  assert.deepEqual(await store.loadOperation(operation.operationId), operation);
  assert.deepEqual(await store.listOperations(), [operation]);
});

test('cancelling a live session logs an address-free reason', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-match-log-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  const store = new BackendGameStore(join(directory, 'games.json'), { logger: { info: (event, fields) => events.push({ event, fields }) } });
  await store.joinMatchmaking({ matchId: 'first-match', address: 'kaspatest:first', publicKey: 'a'.repeat(64), limitKas: 5 });
  await store.joinMatchmaking({ matchId: 'second-match', address: 'kaspatest:first', publicKey: 'a'.repeat(64), limitKas: 5 });

  const replaced = events.filter((entry) => entry.event === 'matchmaking_replaced');
  assert.deepEqual(replaced, [{ event: 'matchmaking_replaced', fields: { matchId: 'first-match', reason: 'rejoin' } }]);
  assert.doesNotMatch(JSON.stringify(events), /kaspatest/);
});
