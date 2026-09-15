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

test('HTTP failures expose a request id and log the safe failure details', async (t) => {
  const logs = [];
  const application = createHttpApplication({
    gameService: { prepareCreation: async () => { throw new Error('backend dependency failed'); } },
    store: { health: async () => {} },
    relay: { size: () => 0 },
    metrics: { recordHttp: () => {}, recordPageVisit: () => {}, setRelayEntries: () => {}, render: () => '' },
    feedbackService: {},
    mutatingLimiter: { check: () => ({ allowed: true }) },
    feedbackLimiter: { check: () => ({ allowed: true }) },
    paths: {},
    maxRequestBytes: 1000,
    logger: { info: (...args) => logs.push(['info', ...args]), warn: (...args) => logs.push(['warn', ...args]), error: (...args) => logs.push(['error', ...args]), debug: () => {} },
  });
  const server = createServer(application.requestHandler);
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/games/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.match(body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(response.headers.get('x-request-id'), body.requestId);
  const errorLog = logs.find(([level, event]) => level === 'error' && event === 'server_error');
  assert.equal(errorLog[2].requestId, body.requestId);
  assert.equal(errorLog[2].code, 'INTERNAL_ERROR');
  assert.equal(errorLog[2].message, 'backend dependency failed');
});

test('oversized requests return a traceable 413 instead of dropping the connection', async (t) => {
  const logs = [];
  const application = createHttpApplication({
    gameService: {}, store: { health: async () => {} }, relay: { size: () => 0 },
    metrics: { recordHttp: () => {}, recordPageVisit: () => {}, setRelayEntries: () => {}, render: () => '' },
    feedbackService: {}, mutatingLimiter: { check: () => ({ allowed: true }) }, feedbackLimiter: { check: () => ({ allowed: true }) },
    paths: {}, maxRequestBytes: 10,
    logger: { info: (...args) => logs.push(['info', ...args]), warn: () => {}, error: (...args) => logs.push(['error', ...args]), debug: () => {} },
  });
  const server = createServer(application.requestHandler);
  t.after(() => server.close());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/games/prepare`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"too":"large"}',
  });
  const body = await response.json();
  assert.equal(response.status, 413);
  assert.equal(body.error, 'REQUEST_TOO_LARGE');
  assert.equal(response.headers.get('x-request-id'), body.requestId);
  const errorLog = logs.find(([level, event]) => level === 'error' && event === 'client_request_rejected');
  assert.equal(errorLog[2].requestId, body.requestId);
  assert.equal(errorLog[2].code, 'REQUEST_TOO_LARGE');
});
