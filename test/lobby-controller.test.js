import test from 'node:test';
import assert from 'node:assert/strict';
import { LOBBY_MODE, LOBBY_PHASE, createLobbyController, matchWaitError } from '../public/lobby-controller.js';

const ACCOUNT = { address: 'kaspatest:me', publicKey: 'a'.repeat(64) };
const GAME_ID = 'g'.repeat(64);
const flush = () => new Promise((resolve) => setImmediate(resolve));

const creatorMatch = (overrides = {}) => ({ matchId: 'r1', status: 'matched', role: 'creator', side: 'even', stakeKas: 6, opponentConnected: true, gameId: null, ...overrides });
const joinerMatch = (overrides = {}) => ({ matchId: 'r1', status: 'matched', role: 'joiner', side: 'odd', stakeKas: 6, opponentConnected: true, gameId: null, ...overrides });
const waitingMatch = () => ({ matchId: 'm1', status: 'waiting', myLimitKas: 5, opponentConnected: false, gameId: null });

function harness(options = {}) {
  const renders = [];
  const navigations = [];
  const roomUrls = [];
  const apiCalls = [];
  const timers = [];
  const cleared = [];
  let connected = 0;

  const api = options.api ?? (async () => ({}));
  const connect = options.connect ?? (async () => { connected += 1; return { provider: { id: 'kasware' }, account: ACCOUNT }; });

  const controller = createLobbyController({
    mode: options.mode ?? LOBBY_MODE.PUBLIC,
    roomId: options.roomId ?? null,
    code: options.code ?? null,
    api: async (url, request) => { apiCalls.push({ url, request }); return api(url, request); },
    connect,
    sign: options.sign ?? (async () => 'signed-tx'),
    createSecret: options.createSecret ?? (async (number) => ({ secretId: 'secret-1', commitment: 'c'.repeat(64), choice: number })),
    verifyCreation: options.verifyCreation ?? (async () => ({ signInputs: [{ index: 0 }] })),
    verifyPrepared: options.verifyPrepared ?? (() => ({ signInputs: [{ index: 0 }] })),
    bindSecret: options.bindSecret ?? (async () => {}),
    gameFeePublicKey: async () => 'f'.repeat(64),
    addressPrefix: () => 'kaspatest',
    navigate: (path) => navigations.push(path),
    replaceUrl: (path) => roomUrls.push(path),
    render: (snapshot) => renders.push(snapshot),
    waitTimeoutMs: options.waitTimeoutMs ?? 60_000,
    pollIntervalMs: options.pollIntervalMs ?? 5,
    botAvailable: options.botAvailable ?? false,
    botStakeKas: options.botStakeKas ?? null,
    botOfferDelayMs: options.botOfferDelayMs ?? 5_000,
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? (async () => {}),
    setIntervalFn: (callback) => { timers.push(callback); return timers.length; },
    clearIntervalFn: (id) => { cleared.push(id); },
  });

  return {
    controller,
    actions: controller.actions,
    renders,
    navigations,
    roomUrls,
    apiCalls,
    timers,
    cleared,
    connectedCount: () => connected,
    last: () => renders[renders.length - 1],
    phases: () => renders.map((snapshot) => snapshot.phase),
    urls: () => apiCalls.map((call) => call.url),
  };
}

function startWith(mode, roomId) {
  const harnessed = harness({ mode, roomId });
  harnessed.controller.start();
  return harnessed;
}



test('the lobby opens on the phase that matches how the player arrived', async () => {
  assert.equal(startWith(LOBBY_MODE.PUBLIC).last().phase, LOBBY_PHASE.LIMIT);
  assert.equal(startWith(LOBBY_MODE.HOST).last().phase, LOBBY_PHASE.HOST_FORM);
  assert.equal(startWith(LOBBY_MODE.HOST, 'r1').last().phase, LOBBY_PHASE.RESUME);

  // A guest who arrived with a link or a code connects immediately: the connect
  // prompt is painted, then the wallet opens without a button press.
  const matched = async () => ({ ...joinerMatch(), matchId: 'r9' });
  const linked = harness({ mode: LOBBY_MODE.GUEST, roomId: 'r1', api: matched });
  const linkedStart = linked.controller.start();
  assert.equal(linked.last().phase, LOBBY_PHASE.GUEST_ENTRY);
  await linkedStart;

  const coded = harness({ mode: LOBBY_MODE.GUEST, code: 'K7PQ2M', api: matched });
  const codedStart = coded.controller.start();
  assert.equal(coded.last().phase, LOBBY_PHASE.GUEST_ENTRY);
  await codedStart;

  // A guest who arrived without a link or a code is here to type one.
  assert.equal(startWith(LOBBY_MODE.GUEST).last().phase, LOBBY_PHASE.CODE_ENTRY);
});

test('a guest handed a code joins directly without retyping it', async () => {
  let joinedBody = null;
  const joined = harness({
    mode: LOBBY_MODE.GUEST,
    code: 'K7PQ2M',
    api: async (url, request) => {
      if (url === '/api/matchmaking/code') { joinedBody = request.body; return { ...joinerMatch(), matchId: 'r9' }; }
      if (url.startsWith('/api/matchmaking/r9?')) return { ...joinerMatch(), matchId: 'r9' };
      return {};
    },
  });
  await joined.controller.start();
  assert.deepEqual(joinedBody, { address: ACCOUNT.address, publicKey: ACCOUNT.publicKey, code: 'K7PQ2M' });
  assert.equal(joined.last().phase, LOBBY_PHASE.PICK);
});

test('a cancelled wallet prompt returns the invited guest to the manual connect button', async () => {
  const rejected = harness({
    mode: LOBBY_MODE.GUEST,
    code: 'K7PQ2M',
    connect: async () => { const error = new Error('not approved'); error.code = 'WALLET_REJECTED'; throw error; },
  });
  await rejected.controller.start();
  assert.equal(rejected.last().phase, LOBBY_PHASE.GUEST_ENTRY);
  assert.equal(rejected.last().busy, false);
  assert.equal(rejected.last().note.kind, 'error');
});

test('a malformed room code is rejected before the wallet is touched', () => {
  const harnessed = startWith(LOBBY_MODE.GUEST);
  harnessed.actions.connectGuestByCode('short');
  assert.equal(harnessed.last().phase, LOBBY_PHASE.CODE_ENTRY);
  assert.equal(harnessed.last().note.kind, 'error');
  assert.equal(harnessed.last().draft, 'short');
  assert.equal(harnessed.connectedCount(), 0);
  assert.deepEqual(harnessed.urls(), []);
});

test('a guest joins a friend room by typing its code', async () => {
  let joinedBody = null;
  const joined = harness({
    mode: LOBBY_MODE.GUEST,
    api: async (url, request) => {
      if (url === '/api/matchmaking/code') { joinedBody = request.body; return { ...joinerMatch(), matchId: 'r9', code: null }; }
      if (url.startsWith('/api/matchmaking/r9?')) return { ...joinerMatch(), matchId: 'r9' };
      return {};
    },
  });
  joined.controller.start();
  await joined.actions.connectGuestByCode('k7pq-2m');
  // The code reaches the API normalized, not as typed.
  assert.deepEqual(joinedBody, { address: ACCOUNT.address, publicKey: ACCOUNT.publicKey, code: 'K7PQ2M' });
  assert.equal(joined.last().phase, LOBBY_PHASE.PICK);
});

test('an invalid stake is rejected before the wallet is touched, keeping the typed value', () => {
  const harnessed = harness();
  harnessed.controller.start();
  harnessed.actions.connectLimit('1000001');
  assert.equal(harnessed.last().phase, LOBBY_PHASE.LIMIT);
  assert.equal(harnessed.last().note.kind, 'error');
  assert.equal(harnessed.last().draft, '1000001');
  assert.equal(harnessed.connectedCount(), 0);
  assert.deepEqual(harnessed.urls(), []);
});

test('a zero limit is rejected before the wallet is touched', () => {
  const harnessed = harness();
  harnessed.controller.start();
  harnessed.actions.connectLimit('0');
  assert.equal(harnessed.last().phase, LOBBY_PHASE.LIMIT);
  assert.equal(harnessed.last().note.kind, 'error');
  assert.equal(harnessed.last().draft, '0');
  assert.equal(harnessed.connectedCount(), 0);
  assert.deepEqual(harnessed.urls(), []);
});

test('a sub-1 KAS stake is rejected, but a fractional stake is accepted', async () => {
  const harnessed = harness();
  harnessed.controller.start();
  harnessed.actions.connectLimit('0.5');
  assert.equal(harnessed.last().phase, LOBBY_PHASE.LIMIT);
  assert.equal(harnessed.last().note.kind, 'error');
  assert.equal(harnessed.last().draft, '0.5');
  assert.equal(harnessed.connectedCount(), 0);
  assert.deepEqual(harnessed.urls(), []);

  const accepted = harness({
    api: async (url) => {
      if (url === '/api/matchmaking/join') return waitingMatch();
      return {};
    },
  });
  accepted.controller.start();
  await accepted.actions.connectLimit('1.5');
  assert.equal(accepted.last().phase, LOBBY_PHASE.WAITING);
  assert.equal(accepted.connectedCount(), 1);
});

test('a public match waits, then flips to the pick screen once paired', async () => {
  let paired = false;
  const harnessed = harness({
    api: async (url) => {
      if (url === '/api/matchmaking/join') return waitingMatch();
      if (url.startsWith('/api/matchmaking/m1?')) return paired ? { ...waitingMatch(), status: 'matched', role: 'joiner', side: 'odd', stakeKas: 5, opponentConnected: true } : waitingMatch();
      return {};
    },
  });
  harnessed.controller.start();
  await harnessed.actions.connectLimit('5');
  assert.equal(harnessed.last().phase, LOBBY_PHASE.WAITING);
  assert.equal(harnessed.timers.length, 1);
  // Let the in-flight polls from entering the wait settle before the timer fires.
  await flush();
  await flush();

  paired = true;
  harnessed.timers[0]();
  await flush();
  await flush();
  assert.equal(harnessed.last().phase, LOBBY_PHASE.PICK);
});

test('a friend room publishes its invite url and waits for the second seat', async () => {
  const harnessed = harness({
    mode: LOBBY_MODE.HOST,
    api: async () => ({ matchId: 'r1', status: 'waiting', stakeKas: 6, opponentConnected: false, gameId: null }),
  });
  harnessed.controller.start();
  await harnessed.actions.connectHost('6');
  assert.equal(harnessed.last().phase, LOBBY_PHASE.WAITING);
  assert.deepEqual(harnessed.roomUrls, ['/host?room=r1']);
});

test('a dead friend invite is a terminal, non-retryable error', async () => {
  const expired = harness({ mode: LOBBY_MODE.GUEST, roomId: 'r1', api: async () => { throw Object.assign(new Error('gone'), { code: 'MATCH_NOT_FOUND' }); } });
  await expired.controller.start();
  assert.equal(expired.last().phase, LOBBY_PHASE.ERROR);
  assert.equal(expired.last().error.action, null);
  assert.equal(expired.last().error.title, 'This invite has expired');

  const used = harness({ mode: LOBBY_MODE.GUEST, roomId: 'r1', api: async () => { throw Object.assign(new Error('full'), { code: 'MATCH_FULL' }); } });
  await used.controller.start();
  assert.equal(used.last().error.title, 'This invite was already used');
});

test('the creator locks only after the pick, then publishes the game', async () => {
  const binds = [];
  const harnessed = harness({
    mode: LOBBY_MODE.HOST,
    bindSecret: async (...args) => binds.push(args),
    api: async (url) => {
      if (url === '/api/matchmaking/room') return creatorMatch();
      if (url === '/api/games/prepare') return { txJson: '{}', preparedHash: 'p'.repeat(64), feeSompi: '0', deadlineDaa: '1', changeScriptPublicKey: '00' };
      if (url === '/api/games/submit') return { gameId: GAME_ID };
      return {};
    },
  });
  harnessed.controller.start();
  await harnessed.actions.connectHost('6');
  assert.equal(harnessed.last().phase, LOBBY_PHASE.PICK);
  assert.equal(harnessed.last().number, null);

  harnessed.actions.selectNumber(1);
  assert.equal(harnessed.last().number, 1);
  await harnessed.actions.play();

  assert.equal(harnessed.phases().includes(LOBBY_PHASE.WALLET), true);
  assert.deepEqual(harnessed.navigations, [`/game?id=${GAME_ID}`]);
  assert.equal(harnessed.urls().includes('/api/games/submit'), true);
  assert.deepEqual(binds, [[GAME_ID, 'secret-1']]);
});

test('a creation failure maps to a retryable start error through the shared copy', async () => {
  const harnessed = harness({
    mode: LOBBY_MODE.HOST,
    api: async (url) => {
      if (url === '/api/matchmaking/room') return creatorMatch();
      if (url === '/api/games/prepare') throw Object.assign(new Error('no coins'), { code: 'NO_UTXOS' });
      return {};
    },
  });
  harnessed.controller.start();
  await harnessed.actions.connectHost('6');
  harnessed.actions.selectNumber(1);
  await harnessed.actions.play();

  assert.equal(harnessed.last().phase, LOBBY_PHASE.ERROR);
  assert.equal(harnessed.last().error.action, 'start');
  assert.equal(harnessed.last().error.title, 'Network fee unavailable');
});

test('the joiner waits for the game id before preparing the join', async () => {
  let polls = 0;
  const harnessed = harness({
    mode: LOBBY_MODE.GUEST,
    roomId: 'r1',
    api: async (url) => {
      if (url === '/api/matchmaking/r1/join') return joinerMatch({ gameId: null });
      if (url.startsWith('/api/matchmaking/r1?')) { polls += 1; return joinerMatch({ gameId: GAME_ID }); }
      if (url === `/api/games/${GAME_ID}/join/prepare`) return { txJson: '{}', preparedHash: 'p'.repeat(64), feeSompi: '0', verification: { action: 'join' } };
      if (url === `/api/games/${GAME_ID}/join/submit`) return {};
      return {};
    },
  });
  await harnessed.controller.start();
  harnessed.actions.selectNumber(0);
  await harnessed.actions.play();

  assert.equal(polls >= 1, true);
  assert.deepEqual(harnessed.navigations, [`/game?id=${GAME_ID}`]);
});

test('an opponent who leaves before the game is created cancels the start', async () => {
  const harnessed = harness({
    mode: LOBBY_MODE.GUEST,
    roomId: 'r1',
    api: async (url) => {
      if (url === '/api/matchmaking/r1/join') return joinerMatch({ gameId: null });
      if (url.startsWith('/api/matchmaking/r1?')) return { ...joinerMatch(), status: 'cancelled', opponentConnected: false };
      return {};
    },
  });
  await harnessed.controller.start();
  harnessed.actions.selectNumber(0);
  await harnessed.actions.play();

  assert.equal(harnessed.last().phase, LOBBY_PHASE.ABANDONED);
});

test('a started game that disappears abandons the joiner while picking', async () => {
  let gone = false;
  const harnessed = harness({
    mode: LOBBY_MODE.GUEST,
    roomId: 'r1',
    api: async (url) => {
      if (url === '/api/matchmaking/r1/join') return joinerMatch({ gameId: GAME_ID, status: 'started' });
      if (url.startsWith('/api/matchmaking/r1?')) {
        if (!gone) return joinerMatch({ gameId: GAME_ID, status: 'started' });
        throw Object.assign(new Error('gone'), { code: 'MATCH_NOT_FOUND' });
      }
      return {};
    },
  });
  await harnessed.controller.start();
  await flush();
  await flush();
  assert.equal(harnessed.last().phase, LOBBY_PHASE.PICK);

  gone = true;
  harnessed.timers[0]();
  await flush();
  await flush();

  assert.equal(harnessed.last().phase, LOBBY_PHASE.ABANDONED);
  assert.equal(harnessed.last().gameCancelled, true);
});

test('a join refused as cancelled abandons the lobby', async () => {
  const harnessed = harness({
    mode: LOBBY_MODE.GUEST,
    roomId: 'r1',
    api: async (url) => {
      if (url === '/api/matchmaking/r1/join') return joinerMatch({ gameId: GAME_ID });
      if (url === `/api/games/${GAME_ID}/join/prepare`) throw Object.assign(new Error('cancelled'), { code: 'GAME_CANCELLED' });
      return {};
    },
  });
  await harnessed.controller.start();
  harnessed.actions.selectNumber(0);
  await harnessed.actions.play();

  assert.equal(harnessed.last().phase, LOBBY_PHASE.ABANDONED);
  assert.equal(harnessed.last().gameCancelled, true);
});

test('an opponent who leaves before a game exists is not a cancelled game', async () => {
  const harnessed = harness({
    mode: LOBBY_MODE.GUEST,
    roomId: 'r1',
    api: async (url) => {
      if (url === '/api/matchmaking/r1/join') return joinerMatch({ gameId: null });
      if (url.startsWith('/api/matchmaking/r1?')) return { ...joinerMatch(), status: 'cancelled', opponentConnected: false };
      return {};
    },
  });
  await harnessed.controller.start();
  harnessed.actions.selectNumber(0);
  await harnessed.actions.play();

  assert.equal(harnessed.last().phase, LOBBY_PHASE.ABANDONED);
  assert.equal(harnessed.last().gameCancelled, false);
});

test('a match that is abandoned cancels polling and stops the wait', async () => {
  let abandoned = false;
  const harnessed = harness({
    api: async (url) => {
      if (url === '/api/matchmaking/join') return waitingMatch();
      if (url.startsWith('/api/matchmaking/m1?')) return abandoned ? { ...waitingMatch(), status: 'cancelled', opponentConnected: false } : waitingMatch();
      return {};
    },
  });
  harnessed.controller.start();
  await harnessed.actions.connectLimit('5');
  await flush();
  await flush();

  abandoned = true;
  harnessed.timers[0]();
  await flush();
  await flush();
  assert.equal(harnessed.last().phase, LOBBY_PHASE.ABANDONED);
  assert.equal(harnessed.cleared.length >= 1, true);
});

test('leaving the wait screen cancels polling and returns home', async () => {
  const harnessed = harness({ api: async () => waitingMatch() });
  harnessed.controller.start();
  await harnessed.actions.connectLimit('5');
  assert.equal(harnessed.timers.length, 1);

  await harnessed.actions.leave();
  assert.equal(harnessed.cleared.length >= 1, true);
  assert.deepEqual(harnessed.navigations, ['/']);
});

test('a poll that arrives after the pick cannot repaint the screen', async () => {
  const harnessed = harness({
    mode: LOBBY_MODE.HOST,
    api: async (url) => {
      if (url === '/api/matchmaking/room') return creatorMatch();
      if (url === '/api/games/prepare') return { txJson: '{}', preparedHash: 'p'.repeat(64), feeSompi: '0', deadlineDaa: '1', changeScriptPublicKey: '00' };
      if (url === '/api/games/submit') return { gameId: GAME_ID };
      return creatorMatch();
    },
  });
  harnessed.controller.start();
  await harnessed.actions.connectHost('6');
  harnessed.actions.selectNumber(1);
  await harnessed.actions.play();

  const settled = harnessed.renders.length;
  harnessed.timers[0]();
  await flush();
  await flush();
  assert.equal(harnessed.renders.length, settled);
});

test('the bot is offered only after the grace period while still waiting', async () => {
  let clock = 0;
  const harnessed = harness({
    botAvailable: true,
    botStakeKas: 1,
    now: () => clock,
    api: async (url) => {
      if (url === '/api/matchmaking/join') return waitingMatch();
      if (url.startsWith('/api/matchmaking/m1?')) return waitingMatch();
      if (url === '/api/matchmaking/m1/bot') return { ...waitingMatch(), status: 'matched', role: 'creator', side: 'even', stakeKas: 1, opponentConnected: true, opponentType: 'bot' };
      return {};
    },
  });
  harnessed.controller.start();
  await harnessed.actions.connectLimit('5');
  assert.equal(harnessed.last().botOffer, false, 'no bot offer before the grace period');

  clock = 6_000;
  harnessed.timers[0]();
  await flush();
  await flush();
  assert.equal(harnessed.last().botOffer, true, 'the bot offer appears once the wait has elapsed');
  assert.equal(harnessed.last().botStakeKas, 1);

  await harnessed.actions.offerBot();
  assert.equal(harnessed.last().phase, LOBBY_PHASE.PICK);
  assert.equal(harnessed.last().match.opponentType, 'bot');
  assert.equal(harnessed.urls().includes('/api/matchmaking/m1/bot'), true);
});

test('a busy bot leaves the player waiting for a human', async () => {
  let clock = 0;
  const harnessed = harness({
    botAvailable: true,
    botStakeKas: 1,
    now: () => clock,
    api: async (url) => {
      if (url === '/api/matchmaking/join') return waitingMatch();
      if (url.startsWith('/api/matchmaking/m1?')) return waitingMatch();
      if (url === '/api/matchmaking/m1/bot') throw Object.assign(new Error('busy'), { code: 'BOT_BUSY' });
      return {};
    },
  });
  harnessed.controller.start();
  await harnessed.actions.connectLimit('5');
  clock = 6_000;
  harnessed.timers[0]();
  await flush();
  await flush();
  assert.equal(harnessed.last().botOffer, true);

  await harnessed.actions.offerBot();
  assert.equal(harnessed.last().phase, LOBBY_PHASE.WAITING);
  assert.equal(harnessed.last().botOffer, false);
  assert.equal(harnessed.last().note.title, 'The bot is busy');
});

test('every refused bot hand-off names its own reason instead of looking inert', async () => {
  const cases = [
    ['BOT_UNAVAILABLE', 'The bot is unavailable'],
    ['BOT_NOT_READY', 'Give it a moment'],
    ['BOT_BUSY', 'The bot is busy'],
  ];
  for (const [code, title] of cases) {
    let clock = 0;
    const harnessed = harness({
      botAvailable: true,
      botStakeKas: 1,
      now: () => clock,
      api: async (url) => {
        if (url === '/api/matchmaking/join') return waitingMatch();
        if (url.startsWith('/api/matchmaking/m1?')) return waitingMatch();
        if (url === '/api/matchmaking/m1/bot') throw Object.assign(new Error(code), { code });
        return {};
      },
    });
    harnessed.controller.start();
    await harnessed.actions.connectLimit('5');
    clock = 6_000;
    harnessed.timers[0]();
    await flush();
    await flush();
    assert.equal(harnessed.last().botOffer, true, `${code}: the offer is visible before the click`);

    await harnessed.actions.offerBot();

    assert.equal(harnessed.last().note.title, title, `${code}: the refusal names its reason`);
    assert.equal(harnessed.last().note.kind, 'info');
    assert.equal(harnessed.last().botOffer, false);
  }
});

test('a poll that resolves after a bot claim cannot repaint the waiting view', async () => {
  let clock = 0;
  let claimed = false;
  let deferNextGet = false;
  let releaseStale = null;
  const botMatched = { ...waitingMatch(), status: 'matched', role: 'creator', side: 'even', stakeKas: 1, opponentConnected: true, opponentType: 'bot' };
  const harnessed = harness({
    botAvailable: true,
    botStakeKas: 1,
    now: () => clock,
    api: async (url) => {
      if (url === '/api/matchmaking/join') return waitingMatch();
      if (url === '/api/matchmaking/m1/bot') { claimed = true; return botMatched; }
      if (url.startsWith('/api/matchmaking/m1?')) {
        if (deferNextGet) {
          deferNextGet = false;
          return new Promise((resolve) => { releaseStale = () => resolve(waitingMatch()); });
        }
        return claimed ? botMatched : waitingMatch();
      }
      return {};
    },
  });
  harnessed.controller.start();
  await harnessed.actions.connectLimit('5');
  clock = 6_000;
  deferNextGet = true;
  for (let attempt = 0; attempt < 3 && !releaseStale; attempt += 1) {
    harnessed.timers[0]();
    await flush();
  }
  assert.ok(releaseStale, 'a poll is in flight before the claim');

  await harnessed.actions.offerBot();
  assert.equal(harnessed.last().phase, LOBBY_PHASE.PICK);

  releaseStale();
  await flush();
  await flush();
  assert.equal(harnessed.last().phase, LOBBY_PHASE.PICK, 'the stale waiting snapshot is ignored');
  assert.equal(harnessed.last().match.opponentType, 'bot');
});

test('no bot offer appears when the bot is not configured', async () => {
  let clock = 0;
  const harnessed = harness({
    botAvailable: false,
    now: () => clock,
    api: async () => waitingMatch(),
  });
  harnessed.controller.start();
  await harnessed.actions.connectLimit('5');
  clock = 60_000;
  harnessed.timers[0]();
  await flush();
  await flush();
  assert.equal(harnessed.last().botOffer, false);
});

test('matchWaitError carries the protocol code it was raised with', () => {
  const error = matchWaitError('MATCH_TIMEOUT', 'too slow');
  assert.equal(error.code, 'MATCH_TIMEOUT');
  assert.equal(error.message, 'too slow');
});
