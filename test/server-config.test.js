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

test('the network-qualified fee address wins over the shared one', () => {
  const shared = bech32Encode('kaspatest', 0, Buffer.from('33'.repeat(32), 'hex'));
  const qualified = bech32Encode('kaspatest', 0, Buffer.from('44'.repeat(32), 'hex'));
  const config = readServerConfig({ KASPA_NETWORK: 'testnet-10', GAME_FEE_ADDRESS: shared, GAME_FEE_ADDRESS_TESTNET_10: qualified });
  assert.equal(config.gameFeePublicKey, '44'.repeat(32));
});

test('server configuration derives the per-network store file from GAME_STORE_DIR', () => {
  assert.equal(readServerConfig({ ...env, GAME_STORE_DIR: '/var/lib/kasodds' }).storePath, '/var/lib/kasodds/games-testnet-10-v10.json');
  assert.equal(readServerConfig({ ...env, KASPA_NETWORK: 'mainnet', GAME_STORE_DIR: '/var/lib/kasodds/' }).storePath, '/var/lib/kasodds/games-mainnet-v10.json');
  // An explicit path always wins over the derived one.
  assert.equal(readServerConfig({ ...env, GAME_STORE_DIR: '/var/lib/kasodds', GAME_STORE_PATH: '/tmp/custom.json' }).storePath, '/tmp/custom.json');
});

test('changing only KASPA_NETWORK switches prefix, store file, and fee wallet', () => {
  const mainnetKey = '22'.repeat(32);
  const testnetKey = '11'.repeat(32);
  const shared = {
    GAME_STORE_DIR: '/var/lib/kasodds',
    GAME_FEE_ADDRESS_MAINNET: bech32Encode('kaspa', 0, Buffer.from(mainnetKey, 'hex')),
    GAME_FEE_ADDRESS_TESTNET_10: bech32Encode('kaspatest', 0, Buffer.from(testnetKey, 'hex')),
  };

  const testnet = readServerConfig({ ...shared, KASPA_NETWORK: 'testnet-10' });
  assert.equal(testnet.network.addressPrefix, 'kaspatest');
  assert.equal(testnet.storePath, '/var/lib/kasodds/games-testnet-10-v10.json');
  assert.equal(testnet.gameFeePublicKey, testnetKey);

  const mainnet = readServerConfig({ ...shared, KASPA_NETWORK: 'mainnet' });
  assert.equal(mainnet.network.addressPrefix, 'kaspa');
  assert.equal(mainnet.storePath, '/var/lib/kasodds/games-mainnet-v10.json');
  assert.equal(mainnet.gameFeePublicKey, mainnetKey);
});

test('the fallback bot key is network-qualified and never crosses networks', () => {
  assert.equal(readServerConfig(env).bot, null);
  assert.throws(() => readServerConfig({ ...env, BOT_PRIVATE_KEY_TESTNET_10: 'nope' }), /32 bytes/);
  assert.throws(() => readServerConfig({ ...env, KASPA_NETWORK: 'mainnet', BOT_PRIVATE_KEY_MAINNET: 'nope' }), /32 bytes/);
  // A key for the other network is ignored, not validated, and keeps the bot off.
  assert.equal(readServerConfig({ ...env, BOT_PRIVATE_KEY_MAINNET: 'nope' }).bot, null);
  assert.equal(readServerConfig({ ...env, KASPA_NETWORK: 'mainnet', BOT_PRIVATE_KEY_TESTNET_10: 'nope' }).bot, null);

  const testnetKey = '11'.repeat(32);
  const mainnetKey = '22'.repeat(32);
  const testnet = readServerConfig({ ...env, BOT_PRIVATE_KEY_TESTNET_10: testnetKey, BOT_PRIVATE_KEY_MAINNET: mainnetKey });
  assert.deepEqual(testnet.bot, { privateKeyHex: testnetKey });
  const mainnet = readServerConfig({ ...env, KASPA_NETWORK: 'mainnet', BOT_PRIVATE_KEY_TESTNET_10: testnetKey, BOT_PRIVATE_KEY_MAINNET: mainnetKey });
  assert.deepEqual(mainnet.bot, { privateKeyHex: mainnetKey });
});

test('server configuration rejects invalid ports', () => {
  assert.throws(() => readServerConfig({ ...env, PORT: '0' }), /PORT must be/);
  assert.throws(() => readServerConfig({ ...env, PORT: '3000', METRICS_PORT: '3000' }), /METRICS_PORT must be/);
});
