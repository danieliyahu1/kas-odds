import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  validateFeedback,
  formatFeedbackMessage,
  FeedbackSpill,
  TelegramFeedback,
  FeedbackService,
  FEEDBACK_MAX_MESSAGE,
} from '../src/feedback.js';
import { Metrics } from '../src/metrics.js';
import { bech32Encode } from '../src/hashes/bech32.mjs';

const feePublicKey = '11'.repeat(32);
const feeAddress = bech32Encode('kaspatest', 0, Buffer.from(feePublicKey, 'hex'));

test('validateFeedback rejects an empty message', () => {
  assert.throws(() => validateFeedback({}), { code: 'INVALID_FEEDBACK' });
  assert.throws(() => validateFeedback({ message: '' }), { code: 'INVALID_FEEDBACK' });
  assert.throws(() => validateFeedback({ message: '   ' }), { code: 'INVALID_FEEDBACK' });
  assert.throws(() => validateFeedback({ message: null }), { code: 'INVALID_FEEDBACK' });
});

test('validateFeedback rejects messages over the length limit', () => {
  assert.throws(() => validateFeedback({ message: 'x'.repeat(FEEDBACK_MAX_MESSAGE + 1) }), { code: 'FEEDBACK_TOO_LONG' });
});

test('validateFeedback returns a trimmed message', () => {
  const result = validateFeedback({ message: '  The reveal felt confusing  ' });
  assert.equal(result.message, 'The reveal felt confusing');
});

test('formatFeedbackMessage is the title and the message, nothing else', () => {
  const text = formatFeedbackMessage({ message: 'The reveal button felt off.' });
  assert.equal(text, 'New Even/Odd feedback:\n\nThe reveal button felt off.');
  assert.doesNotMatch(text, /Page:/);
  assert.doesNotMatch(text, /Screen:/);
  assert.doesNotMatch(text, /Browser:/);
  assert.doesNotMatch(text, /Received:|address|kaspatest:/i);
});

test('TelegramFeedback reports enabled only when both token and chat id are set', () => {
  assert.equal(new TelegramFeedback({}).enabled, false);
  assert.equal(new TelegramFeedback({ botToken: '123' }).enabled, false);
  assert.equal(new TelegramFeedback({ chatId: '123' }).enabled, false);
  assert.equal(new TelegramFeedback({ botToken: '123', chatId: '123' }).enabled, true);
});

test('TelegramFeedback.deliver rejects when not configured', async () => {
  const tg = new TelegramFeedback({});
  await assert.rejects(() => tg.deliver({ message: 'hi' }));
});

test('TelegramFeedback.deliver posts to the Telegram sendMessage endpoint', async () => {
  const calls = [];
  const fetchImpl = (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true };
  };
  const tg = new TelegramFeedback({ botToken: 'tok', chatId: '42', fetchImpl });
  const entry = { message: 'Test feedback', page: '/rival' };
  await tg.deliver(entry);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /bottok\/sendMessage/);
  assert.equal(calls[0].body.chat_id, '42');
  assert.ok(calls[0].body.text.includes('Test feedback'));
  assert.equal(calls[0].body.disable_web_page_preview, true);
});

test('TelegramFeedback.deliver throws on a non-OK response', async () => {
  const fetchImpl = () => ({ ok: false, status: 401 });
  const tg = new TelegramFeedback({ botToken: 'bad', chatId: '1', fetchImpl });
  await assert.rejects(() => tg.deliver({ message: 'hi' }), { message: /401/ });
});

test('FeedbackSpill persists entries to disk and loads them on construction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-spill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'spill.json');
  const now = () => new Date('2026-01-01T00:00:00.000Z');

  const first = new FeedbackSpill({ filePath, now });
  const entry = await first.add({ message: 'queued', page: '/game' });
  assert.ok(entry.id);
  assert.equal(entry.message, 'queued');
  const raw = await readFile(filePath, 'utf8');
  assert.ok(raw.includes('queued'));

  const second = new FeedbackSpill({ filePath, now });
  await second.drain(async () => { throw new Error('keep'); });
  assert.equal(second.entries.length, 1);
  assert.equal(second.entries[0].id, entry.id);
});

test('FeedbackSpill fails closed on malformed persisted JSON', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-spill-corrupt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'spill.json');
  await writeFile(filePath, '{not json', 'utf8');
  await assert.rejects(() => new FeedbackSpill({ filePath }).add({ message: 'no overwrite' }), { code: 'STORAGE_CORRUPT' });
  assert.equal(await readFile(filePath, 'utf8'), '{not json');
});

test('FeedbackSpill preserves read failures instead of treating them as empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-spill-unreadable-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(() => new FeedbackSpill({ filePath: dir }).add({ message: 'no overwrite' }), { code: 'STORAGE_UNAVAILABLE' });
});

test('FeedbackSpill serializes concurrent additions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-spill-concurrent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spill = new FeedbackSpill({ filePath: join(dir, 'nested', 'spill.json') });
  await Promise.all(Array.from({ length: 20 }, (_, index) => spill.add({ message: `entry-${index}` })));
  assert.equal(spill.entries.length, 20);
  assert.equal(JSON.parse(await readFile(spill.filePath, 'utf8')).length, 20);
});

test('FeedbackSpill preserves invalid persistence paths', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-spill-write-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(() => new FeedbackSpill({ filePath: dir }).add({ message: 'cannot use directory' }), { code: 'STORAGE_UNAVAILABLE' });
});

test('FeedbackSpill.remove deletes an entry by id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-spill-remove-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = join(dir, 'spill.json');
  const spill = new FeedbackSpill({ filePath, now: () => new Date('2026-01-01T00:00:00.000Z') });
  const entry = await spill.add({ message: 'to remove' });
  assert.equal(spill.entries.length, 1);
  await spill.remove(entry);
  assert.equal(spill.entries.length, 0);
});

test('FeedbackSpill.drain retries entries that fail and keeps those that succeed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-spill-drain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spill = new FeedbackSpill({ filePath: join(dir, 'spill.json') });
  const a = await spill.add({ message: 'a' });
  const b = await spill.add({ message: 'b' });
  const c = await spill.add({ message: 'c' });

  let callCount = 0;
  await spill.drain(async (entry) => {
    callCount += 1;
    if (entry.id === b.id) throw new Error('transient');
  });

  assert.equal(callCount, 3);
  assert.equal(spill.entries.length, 1);
  assert.equal(spill.entries[0].id, b.id);
  const raw = await readFile(spill.filePath, 'utf8');
  assert.doesNotMatch(raw, /"message":"a"/);
  assert.match(raw, /"message":"b"/);
});

test('FeedbackService.submit writes-ahead to spill, delivers successfully, and removes the entry', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-service-ok-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spill = new FeedbackSpill({ filePath: join(dir, 'spill.json') });
  const calls = [];
  const deliverer = {
    enabled: true,
    deliver: async (entry) => { calls.push(entry); },
  };
  const metrics = new Metrics();
  const service = new FeedbackService({ deliverer, spill, metrics, now: () => new Date('2026-01-01T00:00:00.000Z') });

  const result = await service.submit({ message: 'All good', page: '/host' });
  assert.equal(result.accepted, true);
  assert.equal(result.queued, undefined);
  assert.equal(calls.length, 1);
  assert.equal(spill.entries.length, 0);
  assert.ok(metrics.render().includes('kaspa_feedback_total{outcome="delivered"}'));
});

test('FeedbackService.submit spills but still returns accepted when delivery fails', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-service-fail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spill = new FeedbackSpill({ filePath: join(dir, 'spill.json') });
  const deliverer = {
    enabled: true,
    deliver: async () => { throw new Error('Telegram down'); },
  };
  const service = new FeedbackService({ deliverer, spill, logger: { error() {} } });

  const result = await service.submit({ message: 'Help' });
  assert.equal(result.accepted, true);
  assert.equal(result.queued, true);
  assert.equal(spill.entries.length, 1);
});

test('FeedbackService.submit stores feedback with a warning when Telegram is not configured', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-service-disabled-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const warnings = [];
  const service = new FeedbackService({
    deliverer: { enabled: false },
    spill: new FeedbackSpill({ filePath: join(dir, 'spill.json') }),
    metrics: new Metrics(),
    logger: { warn: (event, fields) => warnings.push({ event, fields }) },
  });

  const result = await service.submit({ message: 'offline note' });
  assert.equal(result.accepted, true);
  assert.equal(result.queued, true);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, 'feedback_delivery_disabled');
  assert.ok(warnings[0].fields.reason.includes('TELEGRAM_FEEDBACK_BOT_TOKEN'));
  assert.equal(service.spill.entries.length, 1);
  assert.equal(service.spill.entries[0].message, 'offline note');
  assert.ok(service.metrics.render().includes('kaspa_feedback_total{outcome="disabled"}'));
});

test('FeedbackService.drainPending retries spilled entries', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-drain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spill = new FeedbackSpill({ filePath: join(dir, 'spill.json') });
  await spill.add({ message: 'drain me' });
  assert.equal(spill.entries.length, 1);

  const delivered = [];
  const deliverer = { enabled: true, deliver: async (entry) => { delivered.push(entry); } };
  const service = new FeedbackService({ deliverer, spill, logger: { info() {} } });
  await service.drainPending();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message, 'drain me');
  assert.equal(spill.entries.length, 0);
});

test('feedback endpoint stores feedback with a warning when Telegram is not configured', async (t) => {
  const port = 6100 + Math.floor(Math.random() * 300);
  const metricsPort = port + 600;
  const directory = await mkdtemp(join(tmpdir(), 'even-odd-feedback-'));
  const spillPath = join(directory, 'spill.json');
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      KASPA_NETWORK: 'testnet-10',
      GAME_STORE_PATH: join(directory, 'games.json'),
      FEEDBACK_SPILL_PATH: spillPath,
      GAME_FEE_ADDRESS: feeAddress,
      RATE_LIMIT_PER_MINUTE: '300',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(() => child.kill());
  t.after(() => rm(directory, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);

  const res = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'still accepted' }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.accepted, true);
  assert.equal(body.queued, true);
  assert.match(logs, /feedback_delivery_disabled/);

  // No bot configured, yet the feedback must be stored, not lost (it will be
  // delivered once the bot is configured and the app restarts).
  for (let i = 0; i < 10; i++) {
    try {
      const raw = await readFile(spillPath, 'utf8');
      const entries = JSON.parse(raw);
      if (entries.length > 0) {
        assert.equal(entries[0].message, 'still accepted');
        return;
      }
    } catch {
      // File may not exist yet; the spill module writes after validation.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('Expected a spilled entry to appear on disk even without Telegram configured');
});

test('feedback endpoint stores undeliverable feedback and retries it against the configured endpoint', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'even-odd-feedback-post-'));
  const spillPath = join(dir, 'spill.json');
  const telegram = await startMockTelegram({ fail: true });
  t.after(() => telegram.close());
  const port = 6400 + Math.floor(Math.random() * 300);
  const metricsPort = port + 600;
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      KASPA_NETWORK: 'testnet-10',
      GAME_STORE_PATH: join(dir, 'games.json'),
      GAME_FEE_ADDRESS: feeAddress,
      FEEDBACK_SPILL_PATH: spillPath,
      TELEGRAM_FEEDBACK_BOT_TOKEN: 'dummy-token-for-test',
      TELEGRAM_FEEDBACK_CHAT_ID: 'dummy-chat-id',
      FEEDBACK_TELEGRAM_SEND_URL: telegram.endpoint,
      RATE_LIMIT_PER_MINUTE: '300',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => rm(dir, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);

  const res = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Loved the game' }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.accepted, true);
  assert.equal(body.queued, true);

  // The app must have called our configured endpoint with the exact payload it
  // would have sent to Telegram.
  assert.equal(telegram.requests.length, 1);
  assert.equal(telegram.requests[0].method, 'POST');
  assert.equal(telegram.requests[0].body.chat_id, 'dummy-chat-id');
  assert.equal(telegram.requests[0].body.text, 'New Even/Odd feedback:\n\nLoved the game');
  assert.equal(telegram.requests[0].body.disable_web_page_preview, true);

  // Delivery failed, so the feedback must be stored and retried later.
  for (let i = 0; i < 10; i++) {
    try {
      const raw = await readFile(spillPath, 'utf8');
      const entries = JSON.parse(raw);
      if (entries.length > 0) {
        assert.ok(entries[0].message.includes('Loved the game'));
        return;
      }
    } catch {
      // File may not exist yet; the spill module writes after validation.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('Expected a spilled entry to appear on disk');
});

test('feedback endpoint delivers immediately and leaves the queue empty when Telegram responds', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'even-odd-feedback-deliver-'));
  const spillPath = join(dir, 'spill.json');
  const telegram = await startMockTelegram({ fail: false });
  t.after(() => telegram.close());
  const port = 6450 + Math.floor(Math.random() * 300);
  const metricsPort = port + 600;
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      KASPA_NETWORK: 'testnet-10',
      GAME_STORE_PATH: join(dir, 'games.json'),
      GAME_FEE_ADDRESS: feeAddress,
      FEEDBACK_SPILL_PATH: spillPath,
      TELEGRAM_FEEDBACK_BOT_TOKEN: 'dummy-token-for-test',
      TELEGRAM_FEEDBACK_CHAT_ID: 'dummy-chat-id',
      FEEDBACK_TELEGRAM_SEND_URL: telegram.endpoint,
      RATE_LIMIT_PER_MINUTE: '300',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => rm(dir, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);

  const res = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Delivered straight away' }),
  });
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.accepted, true);
  assert.equal(body.queued, undefined);
  assert.equal(telegram.requests.length, 1);
  assert.equal(telegram.requests[0].body.text, 'New Even/Odd feedback:\n\nDelivered straight away');

  const raw = await readFile(spillPath, 'utf8');
  assert.deepEqual(JSON.parse(raw), []);
});

test('feedback endpoint rejects empty messages', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'even-odd-feedback-empty-'));
  const telegram = await startMockTelegram({ fail: false });
  t.after(() => telegram.close());
  const port = 6700 + Math.floor(Math.random() * 300);
  const metricsPort = port + 600;
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      KASPA_NETWORK: 'testnet-10',
      GAME_STORE_PATH: join(dir, 'games.json'),
      FEEDBACK_SPILL_PATH: join(dir, 'spill.json'),
      GAME_FEE_ADDRESS: feeAddress,
      TELEGRAM_FEEDBACK_BOT_TOKEN: 'dummy',
      TELEGRAM_FEEDBACK_CHAT_ID: 'dummy',
      FEEDBACK_TELEGRAM_SEND_URL: telegram.endpoint,
      RATE_LIMIT_PER_MINUTE: '300',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => rm(dir, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);

  const res = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '' }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, 'INVALID_FEEDBACK');
});

test('feedback endpoint enforces the per-client rate limit', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'even-odd-feedback-rate-'));
  const telegram = await startMockTelegram({ fail: true });
  t.after(() => telegram.close());
  const port = 7000 + Math.floor(Math.random() * 300);
  const metricsPort = port + 600;
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      METRICS_PORT: String(metricsPort),
      KASPA_NETWORK: 'testnet-10',
      GAME_STORE_PATH: join(dir, 'games.json'),
      FEEDBACK_SPILL_PATH: join(dir, 'spill.json'),
      GAME_FEE_ADDRESS: feeAddress,
      TELEGRAM_FEEDBACK_BOT_TOKEN: 'dummy',
      TELEGRAM_FEEDBACK_CHAT_ID: 'dummy',
      FEEDBACK_TELEGRAM_SEND_URL: telegram.endpoint,
      RATE_LIMIT_PER_MINUTE: '300',
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => rm(dir, { recursive: true, force: true }));
  await waitForServer(`http://127.0.0.1:${port}/readyz`);

  const statuses = [];
  for (let i = 0; i < 8; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: `msg ${i}` }),
    });
    statuses.push(response.status);
  }
  assert.ok(statuses.includes(429), `expected a 429 after the rate limit, saw ${statuses.join(',')}`);
});

async function waitForServer(url) {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* child may still be starting */ }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('Local server did not start');
}

// A contract-faithful stand-in for the Telegram `sendMessage` endpoint. The
// tests drive our app against this local server instead of the real third
// party; it records the POST bodies our app sends and answers with the same
// shape Telegram would (200 + ok body, or a non-OK status).
async function startMockTelegram({ fail }) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, body: JSON.parse(raw || '{}') });
      const status = fail ? 500 : 200;
      const body = fail
        ? { ok: false, error_code: 500, description: 'Service unavailable' }
        : { ok: true, result: { message_id: requests.length } };
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    requests,
    endpoint: `http://127.0.0.1:${port}/sendMessage`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
