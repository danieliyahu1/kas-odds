import test from 'node:test';
import assert from 'node:assert/strict';
import { connectKaswareAccount, ensureKaswareNetwork, kaswareError, normalizePublicKey, readKaswareAccount } from '../public/kasware-connect.js';

const CONFIG = { kaswareNetwork: 'kaspa_testnet_10', addressPrefix: 'kaspatest', configuredNetwork: 'testnet-10' };

// A faithful KasWare fake: Kaspa gives each network its own address, so the
// account the wallet reports changes once it lands on another network. A fake
// that returns one address on every network hides the ordering bug this module
// exists to prevent.
function networkAwareProvider({ network = 'kaspa_mainnet' } = {}) {
  const state = { network, approvals: 0, accountReads: [], switches: [] };
  const addressNow = () => (state.network === 'kaspa_testnet_10' ? 'kaspatest:test' : 'kaspa:main');
  return {
    state,
    provider: {
      requestAccounts: async () => { state.approvals += 1; return [addressNow()]; },
      getAccounts: async () => { state.accountReads.push(state.network); return [addressNow()]; },
      getPublicKey: async () => 'ab'.repeat(32),
      getNetwork: async () => state.network,
      switchNetwork: async (next) => { state.switches.push(next); state.network = next; },
      signPskt: async () => 'signed',
    },
  };
}

test('reads the account only after the wallet reaches the configured network', async () => {
  const { provider, state } = networkAwareProvider({ network: 'kaspa_mainnet' });
  const account = await connectKaswareAccount({ provider, ...CONFIG });
  assert.deepEqual(state.switches, ['kaspa_testnet_10']);
  assert.deepEqual(state.accountReads, ['kaspa_testnet_10']);
  assert.equal(account.address, 'kaspatest:test');
});

test('does not switch a wallet already on the configured network', async () => {
  const { provider, state } = networkAwareProvider({ network: 'kaspa_testnet_10' });
  const account = await connectKaswareAccount({ provider, ...CONFIG });
  assert.deepEqual(state.switches, []);
  assert.equal(account.address, 'kaspatest:test');
});

test('falls back to requestAccounts when the wallet cannot list accounts', async () => {
  const { provider, state } = networkAwareProvider({ network: 'kaspa_mainnet' });
  delete provider.getAccounts;
  const account = await connectKaswareAccount({ provider, ...CONFIG });
  assert.equal(account.address, 'kaspatest:test');
  assert.equal(state.approvals, 2);
});

test('rejects a wallet that cannot switch networks', async () => {
  const { provider } = networkAwareProvider({ network: 'kaspa_mainnet' });
  delete provider.switchNetwork;
  await assert.rejects(() => connectKaswareAccount({ provider, ...CONFIG }), { code: 'WALLET_NETWORK_MISMATCH' });
});

test('rejects a switch that did not land on the configured network', async () => {
  const { provider } = networkAwareProvider({ network: 'kaspa_mainnet' });
  provider.switchNetwork = async () => {};
  await assert.rejects(() => connectKaswareAccount({ provider, ...CONFIG }), { code: 'WALLET_NETWORK_MISMATCH' });
});

test('rejects an account that belongs to another network', async () => {
  const { provider } = networkAwareProvider({ network: 'kaspa_mainnet' });
  provider.getAccounts = async () => ['kaspa:main'];
  await assert.rejects(() => connectKaswareAccount({ provider, ...CONFIG }), { code: 'WALLET_ACCOUNT_MISMATCH' });
});

test('rejects a connection the user did not approve', async () => {
  const provider = { requestAccounts: async () => { throw new Error('denied'); }, signPskt: async () => 'signed' };
  await assert.rejects(() => connectKaswareAccount({ provider, ...CONFIG }), { code: 'WALLET_REJECTED' });
});

test('rejects an empty account list', async () => {
  const provider = { requestAccounts: async () => [], signPskt: async () => 'signed' };
  await assert.rejects(() => connectKaswareAccount({ provider, ...CONFIG }), { code: 'WALLET_REJECTED' });
});

test('rejects a wallet without signing support', async () => {
  const provider = { requestAccounts: async () => ['kaspatest:test'] };
  await assert.rejects(() => connectKaswareAccount({ provider, ...CONFIG }), { code: 'WALLET_UNSUPPORTED' });
});

test('rejects a missing provider', async () => {
  await assert.rejects(() => connectKaswareAccount({ provider: undefined, ...CONFIG }), { code: 'WALLET_UNAVAILABLE' });
});

test('reports a switch through the onSwitch hook', async () => {
  const { provider } = networkAwareProvider({ network: 'kaspa_mainnet' });
  const seen = [];
  await ensureKaswareNetwork(provider, CONFIG.kaswareNetwork, CONFIG.configuredNetwork, { onSwitch: (from) => seen.push(from) });
  assert.deepEqual(seen, ['kaspa_mainnet']);
});

test('reads x-only and compressed public keys, and rejects anything else', async () => {
  assert.equal(normalizePublicKey('AB'.repeat(32)), 'ab'.repeat(32));
  assert.equal(normalizePublicKey(`02${'CD'.repeat(32)}`), 'cd'.repeat(32));
  assert.equal(normalizePublicKey('not-a-key'), null);
  assert.equal(normalizePublicKey(undefined), null);
});

test('reads the active account through getPublicKey', async () => {
  const { provider } = networkAwareProvider({ network: 'kaspa_testnet_10' });
  assert.deepEqual(await readKaswareAccount(provider), { address: 'kaspatest:test', publicKey: 'ab'.repeat(32) });
});

test('tags KasWare errors with a code', () => {
  const error = kaswareError('WALLET_REJECTED', 'nope');
  assert.equal(error.code, 'WALLET_REJECTED');
  assert.equal(error.message, 'nope');
});
