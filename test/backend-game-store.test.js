import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameStore } from '../src/backend-game-store.js';

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

  const afterCreatorConfirm = await store.confirmMatchmaking('first-match', 'kaspatest:first');
  assert.equal(afterCreatorConfirm.status, 'matched');
  assert.equal(afterCreatorConfirm.players[0].confirmed, true);
  const afterJoinerConfirm = await store.confirmMatchmaking('first-match', 'kaspatest:second');
  assert.equal(afterJoinerConfirm.status, 'ready');

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
  assert.ok(low.players.every((player) => player.confirmed === false));

  const solo = await store.joinMatchmaking({ matchId: 'solo', address: 'kaspatest:solo', publicKey: 'c'.repeat(64), limitKas: 3 });
  assert.equal(solo.status, 'waiting');
  assert.equal(solo.stakeKas, null);
});

test('persists games and transaction preparations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-store-'));
  const filePath = join(directory, 'games.json');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(filePath);

  await store.savePrepared({ preparedHash: 'p1', request: { stakeSompi: '1' }, createdAt: 'now' });
  await store.saveJoinPrepared({ preparedHash: 'j1', gameId: 'g'.repeat(64) });
  await store.saveActionPrepared({ preparedHash: 'a1', action: 'refund_player' });
  await store.saveGame({ gameId: 'g'.repeat(64), status: 'broadcast' });

  assert.deepEqual(await store.loadPrepared('p1'), { preparedHash: 'p1', request: { stakeSompi: '1' }, createdAt: 'now' });
  assert.equal((await store.loadJoinPrepared('j1')).gameId, 'g'.repeat(64));
  assert.equal((await store.loadActionPrepared('a1')).action, 'refund_player');
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
