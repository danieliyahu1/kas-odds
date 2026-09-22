import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bech32Encode } from '../src/hashes/bech32.mjs';
import { MATCH_VIEW, resolveMatchView } from '../public/app-controller.js';
import { freePorts } from './free-port.js';

const feePublicKey = '11'.repeat(32);
const feeAddress = bech32Encode('kaspatest', 0, Buffer.from(feePublicKey, 'hex'));

test('server serves the browser application and health probe', async (t) => {
  const [port, metricsPort] = await freePorts(2);
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-server-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      KASPA_NETWORK: 'testnet-10',
      GAME_STORE_PATH: join(directory, 'games.json'),
      GAME_FEE_ADDRESS: feeAddress,
      RATE_LIMIT_PER_MINUTE: '6',
      LOG_LEVEL: 'debug',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => child.kill());
  t.after(() => rm(directory, { recursive: true, force: true }));

  await waitForServer(`http://127.0.0.1:${port}/readyz`);
  const [page, host, rival, protectedPage, health, missing, demoApi, appScript, lobbyScript, mainScript, secretsScript, verifyScript, coreScript, genesisScript, artifact, pins, wasmJs, icon] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/`),
    fetch(`http://127.0.0.1:${port}/host`),
    fetch(`http://127.0.0.1:${port}/rival`),
    fetch(`http://127.0.0.1:${port}/protected`),
    fetch(`http://127.0.0.1:${port}/healthz`),
    fetch(`http://127.0.0.1:${port}/public-game-list`),
    fetch(`http://127.0.0.1:${port}/api/demo/games`),
    fetch(`http://127.0.0.1:${port}/app.js`),
    fetch(`http://127.0.0.1:${port}/lobby-controller.js`),
    fetch(`http://127.0.0.1:${port}/main.js`),
    fetch(`http://127.0.0.1:${port}/secrets.js`),
    fetch(`http://127.0.0.1:${port}/verify.js`),
    fetch(`http://127.0.0.1:${port}/src/covenant/kasodds-core.mjs`),
    fetch(`http://127.0.0.1:${port}/src/genesis-transaction.js`),
    fetch(`http://127.0.0.1:${port}/covenant/kasodds.template.artifact.json`),
    fetch(`http://127.0.0.1:${port}/covenant/pins.json`),
    fetch(`http://127.0.0.1:${port}/vendor/kaspa-wasm32-sdk/v2.0.1/web/kaspa/kaspa.js`),
    fetch(`http://127.0.0.1:${port}/icon.svg`),
  ]);

  assert.equal(page.status, 200);
  assert.equal(host.status, 200);
  assert.equal(rival.status, 200);
  assert.equal(protectedPage.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /KasOdds/);
  assert.match(pageHtml, /Connect Wallet/);
  assert.match(pageHtml, /id="wallet-button"/);
  assert.match(pageHtml, /id="wallet-slot"/);
  assert.match(pageHtml, /<script type="module" src="\/main\.js"><\/script>/);
  assert.doesNotMatch(pageHtml, /<script type="module">import/);
  assert.deepEqual(await health.json().then(({ ok, service, network }) => ({ ok, service, network })), { ok: true, service: 'kasodds', network: 'testnet-10' });
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/config`)).json(), {
    network: 'testnet-10',
    addressPrefix: 'kaspatest',
    kaswareNetwork: 'kaspa_testnet_10',
    protocolVersion: 'EO/v10',
    gameFeePublicKey: feePublicKey,
    explorerUrl: 'https://tn10.kaspa.stream/transactions',
    botAvailable: false,
    botStakeKas: null,
  });
  assert.equal(missing.status, 404);
  assert.equal(demoApi.status, 404);
  const csp = page.headers.get('content-security-policy') ?? '';
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /connect-src 'self'/);
  assert.doesNotMatch(csp, /wss:|ws:/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const browserSource = await appScript.text();
  const lobbySource = await lobbyScript.text();
  assert.equal(lobbyScript.status, 200);
  const secretsSource = await secretsScript.text();
  assert.equal(verifyScript.status, 200);
  assert.equal(mainScript.status, 200);
  assert.match(await mainScript.text(), /import \{ boot \} from '\/app\.js';\s*\nboot\(\);/);
  assert.equal(coreScript.status, 200);
  assert.equal(genesisScript.status, 200);
  assert.equal(artifact.status, 200);
  assert.equal(pins.status, 200);
  assert.equal(wasmJs.status, 200);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type') ?? '', /image\/svg\+xml/);
  assert.equal((await artifact.json()).contracts.KasOdds.compiled.state_span.len, 261);
  assert.match(await pins.json().then((p) => p.rustyKaspa.webVendoredWasmFileSha256), /^[0-9a-f]{64}$/);

  const runtimeConfigScript = await fetch(`http://127.0.0.1:${port}/runtime-config.js`);
  assert.equal(runtimeConfigScript.status, 200);
  assert.match(await runtimeConfigScript.text(), /loadRuntimeConfig/);
  assert.match(pageHtml, /id="network-label"/);
  assert.match(browserSource, /function applyNetworkLabel/);

  // The thin client talks only to this server; it never constructs or verifies
  // chain transactions itself beyond checking the prepared creation.
  assert.doesNotMatch(browserSource, /api\/demo|eo-demo-player|Simulate timeout/);
  assert.match(browserSource, /api\/games\/\$\{gameId\}\/reveal\/prepare/);
  assert.doesNotMatch(browserSource, /api\/matchmaking\/\$\{match\.matchId\}\/confirm/);
  // A matched pair shares one screen; only the joiner's creation wait differs.
  assert.doesNotMatch(browserSource, /Waiting for your rival to create the game/);
  // The stage rail replaced the old opaque "getting your game ready" headings.
  assert.doesNotMatch(browserSource, /Getting your game ready/);
  assert.match(browserSource, /GAME_STAGE\.REVEAL/);
  assert.match(browserSource, /function lockedNumberHtml/);
  assert.match(browserSource, /gameStage\(game, role\)/);
  assert.match(browserSource, /class="stage-rail"/);
  // The covenant timeout is a live clock that re-anchors to the server's
  // covenant-derived remaining time; the view never re-derives the rule.
  assert.match(browserSource, /covenantClock\(game/);
  assert.match(browserSource, /data-game-clock/);
  // app.js keeps the DOM view and the game page; the lobby orchestration lives
  // in the headless controller.
  assert.match(browserSource, /function renderLobby/);
  assert.match(browserSource, /function paintLobby/);
  assert.match(browserSource, /Play for \$\{escapeHtml\(match\.stakeKas\)\} KAS/);
  // A refused bot hand-off must stay visible: the waiting screen renders the
  // controller's notice, and the button reports that the claim is in flight.
  assert.match(browserSource, /Calling the bot&hellip;/);
  assert.match(browserSource, /aria-busy="\$\{busy\}"/);
  assert.match(browserSource, /botPanel\}[\s\S]*?\$\{notice\}/);
  // The pick and game screens state the player's side, stake, and take in one
  // shared, highlighted summary, not a Stake/Pot ledger table.
  assert.match(browserSource, /function matchSummaryHtml\(side, stakeKas\)/);
  assert.match(browserSource, /matchSummaryHtml\(match\.side, match\.stakeKas\)/);
  assert.match(browserSource, /Winner takes/);
  assert.doesNotMatch(browserSource, /function gameDetails\(|class="summary"/);
  assert.match(browserSource, /data-action="reveal"/);
  assert.match(browserSource, /data-match-number/);
  assert.match(browserSource, /Pick your number/);
  assert.match(browserSource, /loadSecretForGame/);
  assert.match(browserSource, /bindSecretToGame/);
  assert.match(browserSource, /deleteSecretForGame/);
  assert.match(browserSource, /kaswareSignPskt/);
  assert.match(browserSource, /Find a player/);
  assert.match(browserSource, /Play with a friend/);
  assert.match(browserSource, /location\.pathname === '\/host'/);
  // The stake-safety page is reachable from the home screen, and it states the
  // timeout guarantee in plain language.
  assert.match(browserSource, /location\.pathname === '\/protected'/);
  assert.match(browserSource, /function renderProtected/);
  // Signing out is an explicit control beside the address, not a click on the
  // address itself, and the address copies the full value.
  assert.match(browserSource, /data-wallet-action="disconnect"/);
  assert.match(browserSource, /data-wallet-action="copy"/);
  assert.match(browserSource, /function onDisconnectClick/);
  assert.match(browserSource, /function onCopyAddressClick/);
  assert.match(browserSource, /class="wallet-address"/);
  assert.match(browserSource, /How your stake is protected/);
  assert.match(browserSource, /covenant\/kasodds\.sil/);
  assert.match(browserSource, /KasOdds/);
  assert.doesNotMatch(browserSource, /DEFAULT_WRPC_URL|WrpcClient|readRecoveryReadiness|game-client|client-actions/);
  assert.doesNotMatch(browserSource, /data-reveal-number|FIXED_NONCE|fill\(1\)|transientCommitment/);
  assert.doesNotMatch(browserSource, /Guess even|Joining unavailable|data-action="create"/);

  // The lobby controller is headless: it owns the matchmaking endpoints, the
  // polling lifecycle, and the parallel creation/join flow, and never touches
  // the DOM.
  assert.match(lobbySource, /\/api\/matchmaking\/join/);
  assert.match(lobbySource, /\/api\/matchmaking\/room/);
  assert.match(lobbySource, /\/api\/matchmaking\/\$\{roomId\}\/join/);
  assert.match(lobbySource, /\/api\/matchmaking\/\$\{match\.matchId\}\/leave/);
  assert.match(lobbySource, /\/api\/games\/prepare/);
  assert.match(lobbySource, /\/api\/games\/submit/);
  assert.match(lobbySource, /\/api\/games\/\$\{gameId\}\/join\/prepare/);
  assert.match(lobbySource, /createSecret\(number/);
  assert.match(lobbySource, /verifyCreation/);
  assert.match(lobbySource, /resolveMatchView/);
  assert.match(lobbySource, /shouldRerenderMatch/);
  assert.match(lobbySource, /matchGameWaitState/);
  assert.doesNotMatch(lobbySource, /document\.|window\.|localStorage/);

  // Regression: the repaint-dedup signature must not track the countdown, or
  // every tick rebuilds the join form and clears the joiner's number selection.
  // It is pure and unit-tested in app-controller.js, so it must not drift back
  // into the view.
  assert.doesNotMatch(browserSource, /function gameSignature\(/);

  // Regression: safety actions are role-scoped. The creator cancels an open
  // game through the Exit link while the game is still unmatched, and the
  // fallback claim is shown only to the first revealer. Viewers and
  // non-participants must never be shown creator-only, first-revealer-only, or
  // player-only recovery controls.
  assert.match(browserSource, /function safetySection\(game, pending\)/);
  assert.match(browserSource, /data-action="exit"/);
  assert.match(browserSource, /function bindExit\(gameId, game, role, pending\)/);
  assert.match(browserSource, /game\.status === 'waiting_for_player_b' && game\.canCancel && role === 'creator'/);
  assert.match(browserSource, /function isFirstRevealer\(game\)/);
  assert.match(browserSource, /address === game\.firstRevealer/);

  assert.match(secretsSource, /getRandomValues/);
  assert.match(secretsSource, /indexedDB/);
  assert.match(secretsSource, /deleteSecretForGame/);
  assert.match(secretsSource, /operationKey/);
  assert.match(secretsSource, /oncomplete/);
  assert.match(secretsSource, /reconcileRevealSecrets/);
  assert.doesNotMatch(secretsSource, /fill\(1\)|FIXED_NONCE|transientCommitment/);

  const modulePaths = [
    '/app.js',
    '/app-controller.js',
    '/lobby-controller.js',
    '/secrets.js',
    '/verify.js',
    '/kasware-signing.js',
    '/kasware-connect.js',
    '/log.js',
    '/src/covenant/kasodds-core.mjs',
    '/src/covenant/template.mjs',
    '/src/genesis-transaction.js',
    '/src/protocol.js',
    '/src/transaction-diagnostics.js',
    '/src/hashes/blake2b.mjs',
    '/src/hashes/blake3.mjs',
    '/src/hashes/bech32.mjs',
    '/src/hashes/hex.mjs',
  ];
  for (const modulePath of modulePaths) {
    const response = await fetch(`http://127.0.0.1:${port}${modulePath}`);
    assert.equal(response.status, 200, `${modulePath} should be served`);
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
  }

  // The browser module graph (client + static source) must be fully reachable
  // without the deleted client-side transaction engine.
  const origin = `http://127.0.0.1:${port}`;
  const seen = new Set();
  const queue = ['/main.js', '/app.js', '/secrets.js', '/verify.js'];
  while (queue.length) {
    const modulePath = queue.shift();
    if (seen.has(modulePath)) continue;
    seen.add(modulePath);
    const response = await fetch(`${origin}${modulePath}`);
    assert.equal(response.status, 200, `${modulePath} should be reachable from the browser graph`);
    assert.match(response.headers.get('content-type') ?? '', /javascript/, `${modulePath} should be JavaScript`);
    const source = await response.text();
    const specifiers = [
      ...[...source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
      ...[...source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]),
    ];
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:') || specifier.startsWith('http') || specifier.startsWith('data:')) continue;
      if (!specifier.startsWith('/') && !specifier.startsWith('.')) continue;
      queue.push(new URL(specifier, new URL(modulePath, origin)).pathname);
    }
  }
  assert.ok(seen.size >= 10, 'the browser module graph should include all client modules');
  assert.ok(!seen.has('/game-client.js'), 'the deleted client engine must not be reachable');

  const relayId = 'ab'.repeat(32);
  const relayPayload = { gameId: relayId, joiner: { publicKey: '08'.repeat(32) }, joinedAddress: 'kaspatest:x' };
  const relayPost = await fetch(`${origin}/api/relay/${relayId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(relayPayload),
  });
  assert.equal(relayPost.status, 200);
  const relayGet = await fetch(`${origin}/api/relay/${relayId}`);
  assert.deepEqual(await relayGet.json(), relayPayload);
  const relayMissing = await fetch(`${origin}/api/relay/${'cd'.repeat(32)}`);
  assert.equal(relayMissing.status, 404);

  const pageHeaders = await fetch(`${origin}/`);
  assert.equal(pageHeaders.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(pageHeaders.headers.get('x-frame-options'), 'DENY');
  assert.equal(pageHeaders.headers.get('referrer-policy'), 'no-referrer');

  // Metrics live on a dedicated internal port and are never served publicly.
  const publicMetrics = await fetch(`${origin}/metrics`);
  assert.equal(publicMetrics.status, 404);
  const metricsOrigin = `http://127.0.0.1:${metricsPort}`;
  const metricsResponse = await fetch(`${metricsOrigin}/metrics`);
  assert.equal(metricsResponse.status, 200);
  assert.match(metricsResponse.headers.get('content-type') ?? '', /text\/plain/);
  const metricsText = await metricsResponse.text();
  assert.match(metricsText, /kasodds_http_requests_total\{/);
  assert.match(metricsText, /kasodds_storage_operations_total\{operation="health"/);
  assert.match(metricsText, /kasodds_process_resident_memory_bytes/);
  assert.doesNotMatch(metricsText, /kaspatest:|[0-9a-f]{64}/);

  // Oversized relay payloads are rejected and the connection is not drained.
  const oversized = await fetch(`${origin}/api/relay/${'ef'.repeat(32)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blob: 'x'.repeat(300_000) }),
  }).catch(() => ({ status: 400 }));
  assert.equal(oversized.status, 400);

  // Mutating API calls are rate limited per client.
  const statuses = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetch(`${origin}/api/matchmaking/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    statuses.push(response.status);
  }
  assert.ok(statuses.includes(429), `expected a 429 after the limit, saw ${statuses.join(',')}`);

  // Structured logs expose route templates and error codes, never identities.
  for (let attempt = 0; attempt < 50 && !/server_started/.test(stderr); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(stderr, /server_started/);
  assert.match(stderr, /http_request/);
  assert.match(stderr, /route="\/api\/matchmaking\/join"/);
  assert.doesNotMatch(stderr, /kaspatest:|[0-9a-f]{64}/);
});

test('matchmaking joins and pairs when the lower limit sets the stake', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-http-match-'));
  const [port, metricsPort] = await freePorts(2);
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      KASPA_NETWORK: 'testnet-10',
      GAME_STORE_PATH: join(directory, 'games.json'),
      RATE_LIMIT_PER_MINUTE: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => rm(directory, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);

  const origin = `http://127.0.0.1:${port}`;
  const post = (path, body) => fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const first = await post('/api/matchmaking/join', { address: 'kaspatest:one', publicKey: 'a'.repeat(64), limitKas: 20 }).then((response) => response.json());
  assert.equal(first.status, 'waiting');
  assert.equal(first.myLimitKas, 20);
  assert.equal(first.stakeKas, null);

  const second = await post('/api/matchmaking/join', { address: 'kaspatest:two', publicKey: 'b'.repeat(64), limitKas: 6 }).then((response) => response.json());
  assert.equal(second.status, 'matched');
  assert.equal(second.stakeKas, 6);

  // Both players see the matched pairing with their assigned role and side.
  const firstStatus = await fetch(`${origin}/api/matchmaking/${first.matchId}?address=kaspatest:one`).then((response) => response.json());
  const secondStatus = await fetch(`${origin}/api/matchmaking/${first.matchId}?address=kaspatest:two`).then((response) => response.json());
  assert.equal(firstStatus.status, 'matched');
  assert.equal(secondStatus.status, 'matched');
  assert.equal(firstStatus.stakeKas, 6);
  assert.notEqual(firstStatus.role, secondStatus.role);

  // Whichever role the server assigns, both players resolve to the same play
  // screen rather than the joiner waiting on a separate status view.
  assert.equal(firstStatus.opponentConnected, true);
  assert.equal(secondStatus.opponentConnected, true);
  assert.equal(resolveMatchView(firstStatus), MATCH_VIEW.PLAY);
  assert.equal(resolveMatchView(secondStatus), MATCH_VIEW.PLAY);
});

test('a friend room pairs the invited wallet at the host stake', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-http-room-'));
  const [port, metricsPort] = await freePorts(2);
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      KASPA_NETWORK: 'testnet-10',
      GAME_STORE_PATH: join(directory, 'games.json'),
      RATE_LIMIT_PER_MINUTE: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => rm(directory, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);

  const origin = `http://127.0.0.1:${port}`;
  const post = (path, body) => fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const host = await post('/api/matchmaking/room', { address: 'kaspatest:host', publicKey: 'a'.repeat(64), stakeKas: 6 }).then((response) => response.json());
  assert.equal(host.status, 'waiting');
  assert.equal(host.stakeKas, 6);

  const friend = await post(`/api/matchmaking/${host.matchId}/join`, { address: 'kaspatest:friend', publicKey: 'b'.repeat(64) }).then((response) => response.json());
  assert.equal(friend.status, 'matched');
  assert.equal(friend.stakeKas, 6);
  assert.equal(friend.role, 'joiner');

  const hostStatus = await fetch(`${origin}/api/matchmaking/${host.matchId}?address=kaspatest:host`).then((response) => response.json());
  assert.equal(hostStatus.role, 'creator');
  assert.notEqual(hostStatus.side, friend.side);
  assert.equal(resolveMatchView(hostStatus), MATCH_VIEW.PLAY);

  // The single second seat is already taken.
  const rejected = await post(`/api/matchmaking/${host.matchId}/join`, { address: 'kaspatest:third', publicKey: 'c'.repeat(64) });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).error, 'MATCH_FULL');
});

test('starts without a fee recipient configured and reports the game fee as not configured', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'kasodds-server-'));
  const [port, metricsPort] = await freePorts(2);
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      KASPA_NETWORK: 'testnet-10',
      GAME_STORE_PATH: join(directory, 'games.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => rm(directory, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/config`)).json(), {
    network: 'testnet-10',
    addressPrefix: 'kaspatest',
    kaswareNetwork: 'kaspa_testnet_10',
    protocolVersion: 'EO/v10',
    gameFeePublicKey: null,
    explorerUrl: 'https://tn10.kaspa.stream/transactions',
    botAvailable: false,
    botStakeKas: null,
  });
});

async function waitForServer(url) {
  for (let attempt = 0; attempt < 750; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child may need a moment to bind its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Local server did not start');
}
