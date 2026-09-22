import test from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_PROFILES, DEFAULT_NETWORK_PROFILE, isSupportedNetwork, resolveNetworkProfile } from '../src/network.js';
import { validateNetwork, validateNetworkMatches, validateGameFeeAddress } from '../src/protocol.js';
import { toInternalNetwork } from '../src/kasware-wallet.js';
import { BackendGameService } from '../src/backend-game-service.js';
import { bech32Encode } from '../src/hashes/bech32.mjs';

test('network profiles map each supported network to its prefix and wallet name', () => {
  assert.deepEqual(Object.keys(NETWORK_PROFILES), ['testnet-10', 'mainnet']);
  assert.deepEqual(resolveNetworkProfile('testnet-10'), { id: 'testnet-10', addressPrefix: 'kaspatest', kaswareNetwork: 'kaspa_testnet_10', explorerUrl: 'https://tn10.kaspa.stream/transactions' });
  assert.deepEqual(resolveNetworkProfile('mainnet'), { id: 'mainnet', addressPrefix: 'kaspa', kaswareNetwork: 'kaspa_mainnet', explorerUrl: 'https://kaspa.stream/transactions' });
  assert.equal(DEFAULT_NETWORK_PROFILE.id, 'testnet-10');
});

test('resolveNetworkProfile fails closed for an unknown or missing network', () => {
  assert.equal(isSupportedNetwork('mainnet'), true);
  assert.equal(isSupportedNetwork('testnet-11'), false);
  assert.throws(() => resolveNetworkProfile('testnet-11'), /KASPA_NETWORK must be one of/);
  assert.throws(() => resolveNetworkProfile(undefined), /KASPA_NETWORK must be one of/);
});

test('network validation accepts every supported network and rejects the rest', () => {
  assert.equal(validateNetwork('mainnet'), 'mainnet');
  assert.equal(validateNetwork('testnet-10'), 'testnet-10');
  assert.throws(() => validateNetwork('testnet-11'), { code: 'WRONG_NETWORK' });
  assert.equal(validateNetworkMatches('mainnet', 'mainnet'), 'mainnet');
  assert.throws(() => validateNetworkMatches('mainnet', 'testnet-10'), { code: 'WRONG_NETWORK' });
});

test('fee address decoding is scoped to the selected network prefix', () => {
  const publicKey = '11'.repeat(32);
  const mainnet = bech32Encode('kaspa', 0, Buffer.from(publicKey, 'hex'));
  assert.equal(validateGameFeeAddress(mainnet, 'kaspa'), publicKey);
  assert.throws(() => validateGameFeeAddress(mainnet, 'kaspatest'), { code: 'INVALID_GAME_FEE' });
});

test('KasWare external network names map to the internal network ids', () => {
  assert.equal(toInternalNetwork('kaspa_mainnet'), 'mainnet');
  assert.equal(toInternalNetwork('kaspa_testnet_10'), 'testnet-10');
  assert.equal(toInternalNetwork('mainnet'), 'mainnet');
  assert.equal(toInternalNetwork('unknown-network'), 'unknown-network');
});

test('the game service reports the injected network profile', () => {
  const gameFeePublicKey = '11'.repeat(32);
  const testnet = new BackendGameService({ rpc: {}, store: {}, gameFeePublicKey, network: resolveNetworkProfile('testnet-10') });
  const mainnet = new BackendGameService({ rpc: {}, store: {}, gameFeePublicKey, network: resolveNetworkProfile('mainnet') });
  assert.deepEqual(testnet.networkStatus(), { network: 'testnet-10', addressPrefix: 'kaspatest', kaswareNetwork: 'kaspa_testnet_10', protocolVersion: 'EO/v10', gameFeePublicKey, explorerUrl: 'https://tn10.kaspa.stream/transactions', botAvailable: false, botStakeKas: null });
  assert.deepEqual(mainnet.networkStatus(), { network: 'mainnet', addressPrefix: 'kaspa', kaswareNetwork: 'kaspa_mainnet', protocolVersion: 'EO/v10', gameFeePublicKey, explorerUrl: 'https://kaspa.stream/transactions', botAvailable: false, botStakeKas: null });
});
