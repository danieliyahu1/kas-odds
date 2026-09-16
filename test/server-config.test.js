import test from 'node:test';
import assert from 'node:assert/strict';
import { readServerConfig } from '../src/server-config.js';
import { bech32Encode } from '../src/hashes/bech32.mjs';

const feePublicKey = '11'.repeat(32);
const env = { KASPA_NETWORK: 'testnet-10', GAME_FEE_PUBLIC_KEY: feePublicKey };

test('server configuration is validated without opening listeners', () => {
  const config = readServerConfig(env);
  assert.equal(config.port, 3000);
  assert.equal(config.metricsPort, 9464);
  assert.equal(config.network.id, 'testnet-10');
  assert.equal(config.network.addressPrefix, 'kaspatest');
  assert.equal(config.network.kaswareNetwork, 'kaspa_testnet_10');
  assert.equal(config.storePath, '.data/games-testnet-10.json');
});

test('server configuration selects the mainnet profile from the environment', () => {
  const config = readServerConfig({ ...env, KASPA_NETWORK: 'mainnet' });
  assert.equal(config.network.id, 'mainnet');
  assert.equal(config.network.addressPrefix, 'kaspa');
  assert.equal(config.network.kaswareNetwork, 'kaspa_mainnet');
  assert.equal(config.storePath, '.data/games-mainnet.json');
});

test('server configuration fails closed without a known network', () => {
  assert.throws(() => readServerConfig({ ...env, KASPA_NETWORK: undefined }), /KASPA_NETWORK must be/);
  assert.throws(() => readServerConfig({ ...env, KASPA_NETWORK: 'testnet-11' }), /KASPA_NETWORK must be/);
});

test('server configuration enforces the fee address prefix of the selected network', () => {
  const mainnetAddress = bech32Encode('kaspa', 0, Buffer.from(feePublicKey, 'hex'));
  const testnetAddress = bech32Encode('kaspatest', 0, Buffer.from(feePublicKey, 'hex'));
  assert.equal(readServerConfig({ KASPA_NETWORK: 'mainnet', GAME_FEE_ADDRESS: mainnetAddress }).gameFeePublicKey, feePublicKey);
  assert.throws(() => readServerConfig({ KASPA_NETWORK: 'mainnet', GAME_FEE_ADDRESS: testnetAddress }), /must be a kaspa: wallet address/);
});

test('server configuration rejects invalid ports', () => {
  assert.throws(() => readServerConfig({ ...env, PORT: '0' }), /PORT must be/);
  assert.throws(() => readServerConfig({ ...env, PORT: '3000', METRICS_PORT: '3000' }), /METRICS_PORT must be/);
});
