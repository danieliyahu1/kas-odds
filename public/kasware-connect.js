// KasWare connection: obtain an account that belongs to the configured network.
//
// Kaspa derives a distinct address per network, so the wallet's account only
// means something once the extension is on the configured network. Reading the
// account before switching networks returns the previously selected network's
// address; that stale address then fails the prefix check and looks like a
// rejected connection. The ordering lives here so it is stated once and can be
// tested without a browser.

const X_ONLY_PUBLIC_KEY = /^[0-9a-f]{64}$/;
const COMPRESSED_PUBLIC_KEY = /^(02|03)[0-9a-f]{64}$/;

export function normalizePublicKey(publicKey) {
  if (typeof publicKey !== 'string') return null;
  const normalized = publicKey.toLowerCase();
  if (X_ONLY_PUBLIC_KEY.test(normalized)) return normalized;
  if (COMPRESSED_PUBLIC_KEY.test(normalized)) return normalized.slice(2);
  return null;
}

export function kaswareError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Land the extension on the configured network before anything else. A wallet
// that cannot switch is a hard failure, not a silent fallback.
export async function ensureKaswareNetwork(provider, kaswareNetwork, configuredNetwork, { onSwitch } = {}) {
  const current = await provider.getNetwork();
  if (current === kaswareNetwork) return;
  if (typeof provider.switchNetwork !== 'function') {
    throw kaswareError('WALLET_NETWORK_MISMATCH', `Switch KasWare to ${configuredNetwork} to play.`);
  }
  onSwitch?.(current);
  await provider.switchNetwork(kaswareNetwork);
  const switched = await provider.getNetwork();
  if (switched !== kaswareNetwork) {
    throw kaswareError('WALLET_NETWORK_MISMATCH', `Switch KasWare to ${configuredNetwork} to play.`);
  }
}

// Read the active account only after the network is settled. getAccounts is
// preferred over requestAccounts so an already-approved connection is not
// prompted twice.
export async function readKaswareAccount(provider) {
  const accounts = typeof provider.getAccounts === 'function' ? await provider.getAccounts() : await provider.requestAccounts();
  const address = Array.isArray(accounts) ? accounts[0] : accounts;
  if (!address) throw kaswareError('WALLET_REJECTED', 'KasWare connection was not approved');
  const publicKey = normalizePublicKey(await provider.getPublicKey());
  if (!publicKey) throw kaswareError('WALLET_ACCOUNT_MISSING', 'KasWare did not return an active account');
  return { address, publicKey };
}

function assertConfiguredNetworkAccount(account, addressPrefix, configuredNetwork) {
  if (!account.address.startsWith(`${addressPrefix}:`)) {
    throw kaswareError('WALLET_ACCOUNT_MISMATCH', `KasWare must use a ${configuredNetwork} account. Switch KasWare to ${configuredNetwork} and select its ${configuredNetwork} account.`);
  }
  return account;
}

async function requestApproval(provider) {
  let accounts;
  try {
    accounts = await provider.requestAccounts();
  } catch {
    throw kaswareError('WALLET_REJECTED', 'KasWare connection was not approved');
  }
  const address = Array.isArray(accounts) ? accounts[0] : accounts;
  if (!address) throw kaswareError('WALLET_REJECTED', 'KasWare connection was not approved');
}

// Approve, settle the network, then read and validate the account that network
// now has — in that order.
export async function connectKaswareAccount({ provider, kaswareNetwork, addressPrefix, configuredNetwork, onSwitch }) {
  if (!provider || typeof provider.requestAccounts !== 'function') {
    throw kaswareError('WALLET_UNAVAILABLE', 'KasWare wallet extension is not installed');
  }
  if (typeof provider.signPskt !== 'function') {
    throw kaswareError('WALLET_UNSUPPORTED', 'KasWare transaction signing is unavailable');
  }
  await requestApproval(provider);
  await ensureKaswareNetwork(provider, kaswareNetwork, configuredNetwork, { onSwitch });
  return assertConfiguredNetworkAccount(await readKaswareAccount(provider), addressPrefix, configuredNetwork);
}
