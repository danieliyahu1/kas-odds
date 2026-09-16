import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bech32Encode } from '../src/hashes/bech32.mjs';

const feePublicKey = '11'.repeat(32);
const feeAddress = bech32Encode('kaspatest', 0, Buffer.from(feePublicKey, 'hex'));

test('server serves the browser application and health probe', async (t) => {
  const port = 3100 + Math.floor(Math.random() * 500);
  const metricsPort = port + 600;
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-server-'));
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
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
  const [page, host, rival, health, missing, demoApi, appScript, mainScript, secretsScript, verifyScript, coreScript, genesisScript, artifact, pins, wasmJs, icon] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/`),
    fetch(`http://127.0.0.1:${port}/host`),
    fetch(`http://127.0.0.1:${port}/rival`),
    fetch(`http://127.0.0.1:${port}/healthz`),
    fetch(`http://127.0.0.1:${port}/public-game-list`),
    fetch(`http://127.0.0.1:${port}/api/demo/games`),
    fetch(`http://127.0.0.1:${port}/app.js`),
    fetch(`http://127.0.0.1:${port}/main.js`),
    fetch(`http://127.0.0.1:${port}/secrets.js`),
    fetch(`http://127.0.0.1:${port}/verify.js`),
    fetch(`http://127.0.0.1:${port}/src/covenant/even-odd-core.mjs`),
    fetch(`http://127.0.0.1:${port}/src/genesis-transaction.js`),
    fetch(`http://127.0.0.1:${port}/covenant/even_odd.template.artifact.json`),
    fetch(`http://127.0.0.1:${port}/covenant/pins.json`),
    fetch(`http://127.0.0.1:${port}/vendor/kaspa-wasm32-sdk/v2.0.1/web/kaspa/kaspa.js`),
    fetch(`http://127.0.0.1:${port}/icon.svg`),
  ]);

  assert.equal(page.status, 200);
  assert.equal(host.status, 200);
  assert.equal(rival.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /Even\/Odd/);
  assert.match(pageHtml, /Connect Wallet/);
  assert.match(pageHtml, /id="wallet-button"/);
  assert.match(pageHtml, /<script type="module" src="\/main\.js"><\/script>/);
  assert.doesNotMatch(pageHtml, /<script type="module">import/);
  assert.deepEqual(await health.json().then(({ ok, service, network }) => ({ ok, service, network })), { ok: true, service: 'kaspa-even-odd', network: 'testnet-10' });
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/config`)).json(), {
    network: 'testnet-10',
    protocolVersion: 'EO/v10',
    gameFeePublicKey: feePublicKey,
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
  assert.equal((await artifact.json()).contracts.EvenOdd.compiled.state_span.len, 261);
  assert.match(await pins.json().then((p) => p.rustyKaspa.webVendoredWasmFileSha256), /^[0-9a-f]{64}$/);

  // The thin client talks only to this server; it never constructs or verifies
  // chain transactions itself beyond checking the prepared creation.
  assert.doesNotMatch(browserSource, /api\/demo|eo-demo-player|Simulate timeout/);
  assert.match(browserSource, /api\/games\/prepare/);
  assert.match(browserSource, /api\/games\/submit/);
  assert.match(browserSource, /api\/games\/\$\{gameId\}\/join\/prepare/);
  assert.match(browserSource, /api\/games\/\$\{gameId\}\/reveal\/prepare/);
  assert.match(browserSource, /api\/matchmaking\/join/);
  assert.match(browserSource, /api\/matchmaking\/\$\{match\.matchId\}\/leave/);
  assert.doesNotMatch(browserSource, /api\/matchmaking\/\$\{match\.matchId\}\/confirm/);
  assert.match(browserSource, /data-action="reveal"/);
  assert.match(browserSource, /data-commit-number/);
  assert.match(browserSource, /data-join-number/);
  assert.match(browserSource, /createRevealSecret\(number/);
  assert.match(browserSource, /verifyCreation\(/);
  assert.match(browserSource, /loadSecretForGame/);
  assert.match(browserSource, /bindSecretToGame/);
  assert.match(browserSource, /deleteSecretForGame/);
  assert.match(browserSource, /signPskt/);
  assert.match(browserSource, /Find a rival/);
  assert.match(browserSource, /Play with a friend/);
  assert.match(browserSource, /location\.pathname === '\/host'/);
  assert.match(browserSource, /Even \/ Odd|Even\/Odd/);
  assert.doesNotMatch(browserSource, /DEFAULT_WRPC_URL|WrpcClient|readRecoveryReadiness|game-client|client-actions/);
  assert.doesNotMatch(browserSource, /data-reveal-number|FIXED_NONCE|fill\(1\)|transientCommitment/);
  assert.doesNotMatch(browserSource, /Guess even|Joining unavailable|data-action="create"/);

  // Regression: the repaint-dedup signature must not track the countdown, or
  // every tick rebuilds the join form and clears the joiner's number selection.
  const gameSignatureFn = browserSource.match(/function gameSignature\(game\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(gameSignatureFn, 'gameSignature should be defined');
  assert.doesNotMatch(gameSignatureFn[1], /return \[[^\]]*safetyRemainingSeconds/);

  // Regression: safety actions are role-scoped. Viewers and non-participants
  // must never be shown creator-only, first-revealer-only, or player-only
  // recovery controls.
  assert.match(browserSource, /function safetySection\(game, role, pending\)/);
  assert.match(browserSource, /const isParticipant = role === 'creator' \|\| role === 'joiner'/);
  assert.match(browserSource, /if \(role !== 'creator'\) return ''/);
  assert.match(browserSource, /connectedAddress\(\) !== game\.firstRevealer/);

  assert.match(secretsSource, /getRandomValues/);
  assert.match(secretsSource, /indexedDB/);
  assert.match(secretsSource, /deleteSecretForGame/);
  assert.match(secretsSource, /operationKey/);
  assert.match(secretsSource, /oncomplete/);
  assert.match(secretsSource, /reconcileRevealSecrets/);
  assert.doesNotMatch(secretsSource, /fill\(1\)|FIXED_NONCE|transientCommitment/);

  const modulePaths = [
    '/app.js',
    '/secrets.js',
    '/verify.js',
    '/kasware-signing.js',
    '/log.js',
    '/src/covenant/even-odd-core.mjs',
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
  assert.match(metricsText, /kaspa_http_requests_total\{/);
  assert.match(metricsText, /kaspa_storage_operations_total\{operation="health"/);
  assert.match(metricsText, /kaspa_process_resident_memory_bytes/);
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
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-http-match-'));
  const port = 3700 + Math.floor(Math.random() * 300);
  const metricsPort = port + 600;
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
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
});

test('starts without a fee recipient configured and reports the game fee as not configured', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-server-'));
  const port = 3700 + Math.floor(Math.random() * 300);
  const metricsPort = port + 600;
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      GAME_STORE_PATH: join(directory, 'games.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => rm(directory, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/config`)).json(), {
    network: 'testnet-10',
    protocolVersion: 'EO/v10',
    gameFeePublicKey: null,
  });
});

async function waitForServer(url) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
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
