import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendGameStore } from '../src/backend-game-store.js';
import { FallbackBotService } from '../src/fallback-bot-service.js';
import { createRevealSecret, verifyRevealPreimage } from '../src/reveal.js';

const GAME_ID = 'ab'.repeat(32);
const MATCH_ID = 'm1';
const BOT = { address: 'kaspatest:bot', publicKey: 'b'.repeat(64) };

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-bot-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new BackendGameStore(join(directory, 'games.json'));
  const calls = [];
  const reads = {};
  const gameService = {
    prepareJoin: async (gameId, input) => { calls.push({ call: 'prepareJoin', gameId, input }); return { txJson: 'join-tx', preparedHash: 'j'.repeat(64) }; },
    submitJoin: async (gameId, input) => { calls.push({ call: 'submitJoin', gameId, input }); return {}; },
    readGame: async (gameId) => reads[gameId] ?? { canReveal: false },
    prepareReveal: async (gameId, input) => { calls.push({ call: 'prepareReveal', gameId, input }); return { txJson: 'reveal-tx', preparedHash: 'r'.repeat(64) }; },
    submitReveal: async (gameId, input) => { calls.push({ call: 'submitReveal', gameId, input }); return {}; },
  };
  const wallet = { address: BOT.address, publicKey: BOT.publicKey, sign: (txJson) => `signed:${txJson}` };
  const service = new FallbackBotService({ gameService, store, wallet, now: () => Date.now(), unfundedTimeoutMs: 60_000 });
  return { store, calls, reads, gameService, wallet, service };
}

async function matchedBotGame(store) {
  await store.joinMatchmaking({ matchId: MATCH_ID, address: 'kaspatest:human', publicKey: 'a'.repeat(64), limitKas: 5 });
  await store.claimWaitingMatchForBot({ matchId: MATCH_ID, bot: BOT, minWaitMs: 0 });
  await store.updateMatch(MATCH_ID, (match) => { match.status = 'started'; match.gameId = GAME_ID; });
  await store.saveGame({ gameId: GAME_ID, matchId: MATCH_ID, status: 'broadcast' });
}

test('the bot joins with a random commitment it persists before submitting', async (t) => {
  const { store, calls, gameService, service } = await setup(t);
  await matchedBotGame(store);

  const seenAtSubmit = [];
  const submit = gameService.submitJoin;
  gameService.submitJoin = async (gameId, input) => { seenAtSubmit.push(await store.loadBotSecret(GAME_ID)); return submit(gameId, input); };

  await service.runOnce();

  const secret = await store.loadBotSecret(GAME_ID);
  assert.ok(secret, 'the bot stores its commit-reveal secret');
  assert.ok(secret.choice === 0 || secret.choice === 1);
  assert.equal(secret.nonceHex.length, 64);
  assert.equal(verifyRevealPreimage({ commitment: secret.commitment, choice: secret.choice, nonceHex: secret.nonceHex }), true);
  const prepare = calls.find((entry) => entry.call === 'prepareJoin');
  assert.equal(prepare.input.joinerAddress, BOT.address);
  assert.equal(prepare.input.joinerPublicKey, BOT.publicKey);
  assert.equal(prepare.input.matchId, MATCH_ID);
  assert.equal(prepare.input.joinerCommitment, secret.commitment);
  assert.deepEqual(seenAtSubmit, [secret], 'the secret is persisted before the join is submitted');
  assert.equal(calls.find((entry) => entry.call === 'submitJoin').input.signedTxJson, 'signed:join-tx');
});

test('the bot reveals the number it stored when it joined', async (t) => {
  const { store, calls, reads, service } = await setup(t);
  await matchedBotGame(store);
  const stored = createRevealSecret({ gameId: GAME_ID, player: BOT.address, choice: 1 });
  await store.saveBotSecret(GAME_ID, { choice: stored.choice, nonceHex: stored.nonceHex, commitment: stored.commitment });
  await store.saveGame({ gameId: GAME_ID, matchId: MATCH_ID, status: 'joined', join: { joinerAddress: BOT.address, transactionId: 't'.repeat(64) } });
  reads[GAME_ID] = { canReveal: true };

  await service.runOnce();

  const prepare = calls.find((entry) => entry.call === 'prepareReveal');
  assert.ok(prepare, 'the bot prepares the reveal');
  assert.equal(prepare.input.playerAddress, BOT.address);
  assert.equal(prepare.input.choice, stored.choice);
  assert.equal(prepare.input.nonceHex, stored.nonceHex);
  assert.equal(calls.find((entry) => entry.call === 'submitReveal').input.signedTxJson, 'signed:reveal-tx');
});

test('a restart reuses the persisted secret instead of drawing a new one', async (t) => {
  const { store, calls, gameService, wallet, service } = await setup(t);
  await matchedBotGame(store);
  await service.runOnce();
  const first = await store.loadBotSecret(GAME_ID);

  const restarted = new FallbackBotService({ gameService, store, wallet, unfundedTimeoutMs: 60_000 });
  await restarted.runOnce();

  const commitments = calls.filter((entry) => entry.call === 'prepareJoin').map((entry) => entry.input.joinerCommitment);
  assert.equal(commitments.length, 2, 'both runs prepare the join');
  assert.equal(commitments[0], commitments[1]);
  assert.deepEqual(await store.loadBotSecret(GAME_ID), first);
});

test('the bot does not reveal without a stored secret', async (t) => {
  const { store, calls, reads, service } = await setup(t);
  await store.saveGame({ gameId: GAME_ID, matchId: MATCH_ID, status: 'joined', join: { joinerAddress: BOT.address, transactionId: 't'.repeat(64) } });
  reads[GAME_ID] = { canReveal: true };

  await service.runOnce();

  assert.equal(calls.some((entry) => entry.call === 'prepareReveal'), false);
});

test('the bot never reveals twice for the same game', async (t) => {
  const { store, calls, reads, service } = await setup(t);
  await store.saveGame({
    gameId: GAME_ID, matchId: MATCH_ID, status: 'first_revealed',
    join: { joinerAddress: BOT.address, transactionId: 't'.repeat(64) },
    reveals: [{ playerAddress: BOT.address, status: 'broadcast' }],
  });
  reads[GAME_ID] = { canReveal: true };

  await service.runOnce();

  assert.equal(calls.some((entry) => entry.call === 'prepareReveal'), false);
});

test('an unfunded bot match expires and releases the lease', async (t) => {
  const { store, service } = await setup(t);
  await store.joinMatchmaking({ matchId: MATCH_ID, address: 'kaspatest:human', publicKey: 'a'.repeat(64), limitKas: 5 });
  await store.claimWaitingMatchForBot({ matchId: MATCH_ID, bot: BOT, minWaitMs: 0 });
  await store.updateMatch(MATCH_ID, (match) => { match.botClaimedAt = new Date(Date.now() - 120_000).toISOString(); });

  await service.runOnce();

  assert.equal((await store.loadMatch(MATCH_ID)).status, 'cancelled');
  await store.joinMatchmaking({ matchId: 'm2', address: 'kaspatest:other', publicKey: 'c'.repeat(64), limitKas: 5 });
  await store.claimWaitingMatchForBot({ matchId: 'm2', bot: BOT, minWaitMs: 0 });
});

test('a completed bot game releases the lease without further action', async (t) => {
  const { store, service } = await setup(t);
  await matchedBotGame(store);
  await store.saveGame({ gameId: GAME_ID, matchId: MATCH_ID, status: 'settled', completedAt: new Date().toISOString(), join: { joinerAddress: BOT.address, transactionId: 't'.repeat(64) } });

  await service.runOnce();

  await store.joinMatchmaking({ matchId: 'm2', address: 'kaspatest:other', publicKey: 'c'.repeat(64), limitKas: 5 });
  await store.claimWaitingMatchForBot({ matchId: 'm2', bot: BOT, minWaitMs: 0 });
});
