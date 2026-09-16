import { ProtocolError, validateNetworkMatches } from './protocol.js';
import { NETWORK_PROFILES, DEFAULT_NETWORK_PROFILE, isSupportedNetwork } from './network.js';

// KasWare names networks differently from the Kaspa SDK. The application uses
// the SDK form (`testnet-10`, `mainnet`); the extension speaks `kaspa_testnet_10`
// and `kaspa_mainnet`.
const INTERNAL_NETWORKS = Object.freeze(Object.fromEntries(
  Object.entries(NETWORK_PROFILES).map(([internal, profile]) => [profile.kaswareNetwork, internal]),
));

export class KaswareWalletAdapter {
  constructor(provider, { onChange, network = DEFAULT_NETWORK_PROFILE } = {}) {
    this.provider = provider;
    this.networkProfile = network;
    this.account = null;
    this.network = null;
    this.invalidated = false;
    this.removeListeners = [];
    this.changeListeners = new Set(typeof onChange === 'function' ? [onChange] : []);
  }

  async connect() {
    if (!this.provider || typeof this.provider.requestAccounts !== 'function') {
      throw new ProtocolError('WALLET_UNAVAILABLE', 'KasWare wallet extension is not installed');
    }
    const approvedAddress = await this.#requestApproval();
    if (typeof this.provider.signPskt !== 'function') {
      throw new ProtocolError('WALLET_UNSUPPORTED', 'KasWare signPskt capability is required');
    }
    // Kaspa derives a distinct address per network, so the network is settled
    // before the account is read; the approved address is only a fallback for
    // extensions without a non-prompting getAccounts.
    const network = await this.#resolveNetwork();
    const address = await this.#activeAddress(approvedAddress);
    const publicKey = normalizePublicKey(await this.provider.getPublicKey());
    if (!address.startsWith(`${this.networkProfile.addressPrefix}:`)) {
      throw new ProtocolError('WALLET_ACCOUNT_MISMATCH', 'KasWare account must use a wallet on the configured network');
    }
    if (!publicKey) {
      throw new ProtocolError('WALLET_ACCOUNT_MISSING', 'KasWare did not return an active account');
    }
    this.account = Object.freeze({ address, publicKey });
    this.network = network;
    this.invalidated = false;
    this.#listen('accountsChanged', (next) => {
      const nextAddress = Array.isArray(next) ? next[0] : next;
      if (nextAddress !== this.account?.address) this.#invalidate('account');
    });
    this.#listen('networkChanged', (nextNetwork) => {
      if (toInternalNetwork(nextNetwork) !== this.networkProfile.id) this.#invalidate('network');
    });
    return Object.freeze({ address, publicKey, network });
  }

  async #requestApproval() {
    let accounts;
    try {
      accounts = await this.provider.requestAccounts();
    } catch {
      throw new ProtocolError('WALLET_REJECTED', 'KasWare connection was not approved');
    }
    if (!Array.isArray(accounts) || accounts.length === 0 || !accounts[0]) {
      throw new ProtocolError('WALLET_REJECTED', 'KasWare connection was not approved');
    }
    return accounts[0];
  }

  async #activeAddress(approvedAddress) {
    const accounts = await this.#readAccounts();
    return (Array.isArray(accounts) && accounts[0]) || approvedAddress;
  }

  async sign(prepared) {
    if (!this.account || this.invalidated) {
      throw new ProtocolError('WALLET_CHANGED', 'Reconnect KasWare after an account or network change');
    }
    validateNetworkMatches(prepared.network, this.networkProfile.id);
    const expected = prepared.address ?? prepared.creatorAddress ?? prepared.joinerAddress ?? prepared.caller;
    if (expected && expected !== this.account.address) {
      throw new ProtocolError('WALLET_ACCOUNT_MISMATCH', 'Prepared account does not match the active KasWare account');
    }
    if (typeof prepared.txJson !== 'string' || !prepared.preparedHash) {
      throw new ProtocolError('INVALID_TRANSACTION', 'Prepared SafeJSON and template hash are required');
    }
    validateNetworkMatches(toInternalNetwork(await this.provider.getNetwork()), this.networkProfile.id);
    const signedTxJson = await this.provider.signPskt({ txJsonString: prepared.txJson });
    const [accounts, network] = await Promise.all([this.#readAccounts(), this.provider.getNetwork()]);
    if (this.invalidated
      || (accounts && accounts[0] !== this.account.address)
      || toInternalNetwork(network) !== this.networkProfile.id) {
      this.invalidated = true;
      throw new ProtocolError('WALLET_CHANGED', 'Wallet changed during transaction approval');
    }
    if (typeof signedTxJson !== 'string' || signedTxJson.length === 0) {
      throw new ProtocolError('SIGNING_FAILED', 'KasWare did not return signed SafeJSON');
    }
    return signedTxJson;
  }

  dispose() {
    for (const remove of this.removeListeners) remove();
    this.removeListeners = [];
    this.changeListeners.clear();
  }

  subscribe(onChange) {
    if (typeof onChange !== 'function') throw new ProtocolError('INVALID_CALLBACK', 'Wallet change callback is required');
    this.changeListeners.add(onChange);
    return () => this.changeListeners.delete(onChange);
  }

  async #resolveNetwork() {
    const current = toInternalNetwork(await this.provider.getNetwork());
    if (current === this.networkProfile.id) return this.networkProfile.id;
    if (typeof this.provider.switchNetwork !== 'function') validateNetworkMatches(current, this.networkProfile.id);
    await this.provider.switchNetwork(this.networkProfile.kaswareNetwork);
    const switched = toInternalNetwork(await this.provider.getNetwork());
    validateNetworkMatches(switched, this.networkProfile.id);
    return this.networkProfile.id;
  }

  async #readAccounts() {
    if (typeof this.provider.getAccounts !== 'function') return null;
    const accounts = await this.provider.getAccounts();
    return Array.isArray(accounts) ? accounts : null;
  }

  #listen(event, handler) {
    if (typeof this.provider.on !== 'function') return;
    this.provider.on(event, handler);
    this.removeListeners.push(() => this.provider.removeListener?.(event, handler));
  }

  #invalidate(reason) {
    if (this.invalidated) return;
    this.invalidated = true;
    for (const listener of this.changeListeners) listener({ reason, account: null, network: null });
  }
}

export async function waitForKaswareProvider({ getProvider, attempts = 20, intervalMs = 100, wait = defaultWait }) {
  if (typeof getProvider !== 'function') {
    throw new ProtocolError('WALLET_UNAVAILABLE', 'KasWare provider detector is required');
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const provider = getProvider();
    if (provider) return provider;
    if (attempt + 1 < attempts) await wait(intervalMs);
  }
  throw new ProtocolError('WALLET_UNAVAILABLE', 'KasWare wallet extension is not installed');
}

export function toInternalNetwork(network) {
  if (isSupportedNetwork(network)) return network;
  return INTERNAL_NETWORKS[network] ?? network;
}

export function normalizePublicKey(publicKey) {
  if (typeof publicKey !== 'string') return null;
  const normalized = publicKey.toLowerCase();
  if (/^[0-9a-f]{64}$/.test(normalized)) return normalized;
  if (/^(02|03)[0-9a-f]{64}$/.test(normalized)) return normalized.slice(2);
  return null;
}

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
