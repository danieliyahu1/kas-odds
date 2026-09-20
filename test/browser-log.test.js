import test from 'node:test';
import assert from 'node:assert/strict';
import { setLogDebug, logDebug, logInfo, logWarn, logError, formatFields } from '../public/log.js';

function captureConsole() {
  const original = globalThis.console;
  const lines = [];
  const stub = {
    debug: (...args) => lines.push(`debug:${args.join(' ')}`),
    info: (...args) => lines.push(`info:${args.join(' ')}`),
    warn: (...args) => lines.push(`warn:${args.join(' ')}`),
    error: (...args) => lines.push(`error:${args.join(' ')}`),
    log: (...args) => lines.push(`log:${args.join(' ')}`),
  };
  globalThis.console = stub;
  return { lines, restore: () => { globalThis.console = original; } };
}

test('verbose browser logs are gated while warnings and errors always emit', () => {
  const capture = captureConsole();
  try {
    setLogDebug(false);
    logDebug('debug_event');
    logInfo('info_event');
    assert.equal(capture.lines.length, 0);
    logWarn('warn_event');
    logError('error_event');
    assert.match(capture.lines[0], /warn:\[kasodds\] warn_event$/);
    assert.match(capture.lines[1], /error:\[kasodds\] error_event$/);
    setLogDebug(true);
    logDebug('debug_on', { status: 1 });
    assert.match(capture.lines[2], /debug:\[kasodds\] debug_on status=1$/);
  } finally {
    capture.restore();
    setLogDebug(undefined);
  }
});

test('browser logger redacts secrets and formats scalars', () => {
  const formatted = formatFields({
    address: 'kaspatest:qpg2gxu',
    nonce: 'aa'.repeat(32),
    commitment: 'bb'.repeat(32),
    message: 'boom',
    nested: { a: 1 },
  });
  assert.match(formatted, /address=<redacted>/);
  assert.match(formatted, /nonce=<redacted>/);
  assert.match(formatted, /commitment=<redacted>/);
  assert.match(formatted, /message="boom"/);
  assert.match(formatted, /nested=/);
});
