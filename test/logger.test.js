import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, sanitizeFields } from '../src/logger.js';

function capture() {
  const lines = [];
  return { lines, stream: { write: (chunk) => { lines.push(chunk.replace(/\n$/, '')); } } };
}

test('logger filters messages below the configured level', () => {
  const { lines, stream } = capture();
  const logger = createLogger({ level: 'warn', stream, now: () => new Date('2026-01-01T00:00:00.000Z') });
  logger.debug('debug_event');
  logger.info('info_event');
  logger.warn('warn_event', { status: 400 });
  logger.error('error_event');
  assert.deepEqual(lines, [
    '2026-01-01T00:00:00.000Z WARN warn_event status=400',
    '2026-01-01T00:00:00.000Z ERROR error_event',
  ]);
});

test('logger emits structured JSON when configured', () => {
  const { lines, stream } = capture();
  const logger = createLogger({ level: 'info', format: 'json', stream, now: () => new Date('2026-01-01T00:00:00.000Z') });
  logger.info('http_request', { method: 'POST', route: '/api/games/prepare', status: 400 });
  assert.deepEqual(JSON.parse(lines[0]), {
    time: '2026-01-01T00:00:00.000Z',
    level: 'info',
    event: 'http_request',
    method: 'POST',
    route: '/api/games/prepare',
    status: 400,
  });
});

test('logger redacts identity and secret fields', () => {
  const { lines, stream } = capture();
  const logger = createLogger({ level: 'debug', stream, now: () => new Date('2026-01-01T00:00:00.000Z') });
  logger.info('session', {
    address: 'kaspatest:qpg2gxu40zmtuwnsgny5mh7d7sq59dzfsnfsn0u5ds79az0tjh2g7f6gwpdn7',
    nonce: 'aa'.repeat(32),
    publicKey: 'bb'.repeat(32),
    preparedHash: 'cc'.repeat(32),
    body: '{"secret":true}',
    status: 200,
  });
  assert.match(lines[0], /address=<redacted>/);
  assert.match(lines[0], /nonce=<redacted>/);
  assert.match(lines[0], /status=200/);
  assert.doesNotMatch(lines[0], /kaspatest:|a{64}|b{64}|c{64}|\{"secret":true\}/);
});

test('sanitizeFields coerces errors and truncates long values', () => {
  const safe = sanitizeFields({ message: new Error('boom'), long: 'x'.repeat(500), missing: undefined });
  assert.equal(safe.message, 'boom');
  assert.equal(safe.missing, undefined);
  assert.ok(safe.long.length <= 201);
});

test('logger sanitizes sensitive values embedded in error messages', () => {
  const safe = sanitizeFields({ message: `WASM rejected ${'a'.repeat(64)} for kaspatest:qabc` });
  assert.equal(safe.message, 'WASM rejected <txid> for <address>');
});

test('logger preserves a bounded sanitized node rejection', () => {
  const safe = sanitizeFields({
    nodeMessage: `Rejected transaction ${'a'.repeat(64)} for kaspatest:qabc ${'x'.repeat(2500)}`,
  });
  assert.match(safe.nodeMessage, /Rejected transaction <txid> for <address>/);
  assert.ok(safe.nodeMessage.length <= 2001);
  assert.doesNotMatch(safe.nodeMessage, /a{64}|kaspatest:/);
});

test('logger removes signatures embedded in node rejection messages', () => {
  const signature = `41${'ab'.repeat(65)}`;
  const safe = sanitizeFields({ nodeMessage: `rejected signatureScript ${signature}` });
  assert.equal(safe.nodeMessage, 'rejected signatureScript <hex>');
  assert.doesNotMatch(safe.nodeMessage, /ab{20}/);
});

test('logger reveals wallet addresses only when redactAddresses is disabled', () => {
  const { lines, stream } = capture();
  const logger = createLogger({ level: 'info', stream, now: () => new Date('2026-01-01T00:00:00.000Z'), redactAddresses: false });
  logger.info('session', {
    address: 'kaspatest:qpg2gxu40zmtuwnsgny5mh7d7sq59dzfsnfsn0u5ds79az0tjh2g7f6gwpdn7',
    nonce: 'aa'.repeat(32),
    publicKey: 'bb'.repeat(32),
    commitment: 'cc'.repeat(32),
    body: '{"secret":true}',
  });
  assert.match(lines[0], /address="kaspatest:qpg2gxu40zmtuwnsgny5mh7d7sq59dzfsnfsn0u5ds79az0tjh2g7f6gwpdn7"/);
  assert.match(lines[0], /nonce=<redacted>/);
  assert.match(lines[0], /publicKey=<redacted>/);
  assert.match(lines[0], /commitment=<redacted>/);
  assert.match(lines[0], /body=<redacted>/);
});

test('sanitizeFields can reveal addresses without exposing secrets', () => {
  const safe = sanitizeFields({ address: 'kaspatest:abc', nonce: 'n' }, { redactAddresses: false });
  assert.equal(safe.address, 'kaspatest:abc');
  assert.equal(safe.nonce, '<redacted>');
});
