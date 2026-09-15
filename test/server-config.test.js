import test from 'node:test';
import assert from 'node:assert/strict';
import { readServerConfig } from '../src/server-config.js';

const env = { GAME_FEE_PUBLIC_KEY: '11'.repeat(32) };

test('server configuration is validated without opening listeners', () => {
  const config = readServerConfig(env);
  assert.equal(config.port, 3000);
  assert.equal(config.metricsPort, 9464);
  assert.equal(config.network, 'testnet-10');
});

test('server configuration rejects invalid ports', () => {
  assert.throws(() => readServerConfig({ ...env, PORT: '0' }), /PORT must be/);
  assert.throws(() => readServerConfig({ ...env, PORT: '3000', METRICS_PORT: '3000' }), /METRICS_PORT must be/);
});
