import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHttpApplication } from '../src/http-application.js';

test('HTTP application can be constructed and exercised without process side effects', async (t) => {
  const logs = [];
  const application = createHttpApplication({
    gameService: { networkStatus: async () => ({ network: 'testnet-10' }) },
    store: { health: async () => {} },
    relay: { size: () => 0 },
    metrics: { recordHttp: () => {}, recordPageVisit: () => {}, setRelayEntries: () => {}, render: () => '' },
    feedbackService: {},
    mutatingLimiter: { check: () => ({ allowed: true }) },
    feedbackLimiter: { check: () => ({ allowed: true }) },
    paths: {},
    maxRequestBytes: 1000,
    logger: { info: (...args) => logs.push(args), warn: () => {}, error: () => {}, debug: () => {} },
  });
  const server = createServer(application.requestHandler);
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.match(logs.flat().join(' '), /http_request/);
});
