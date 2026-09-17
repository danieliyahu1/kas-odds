export const NETWORK_PROFILES = Object.freeze({
  'testnet-10': Object.freeze({
    id: 'testnet-10',
    addressPrefix: 'kaspatest',
    kaswareNetwork: 'kaspa_testnet_10',
    explorerUrl: 'https://tn10.kaspa.stream/transactions',
  }),
  mainnet: Object.freeze({
    id: 'mainnet',
    addressPrefix: 'kaspa',
    kaswareNetwork: 'kaspa_mainnet',
    explorerUrl: 'https://kaspa.stream/transactions',
  }),
});

export const DEFAULT_NETWORK_PROFILE = NETWORK_PROFILES['testnet-10'];

export function isSupportedNetwork(id) {
  return Object.prototype.hasOwnProperty.call(NETWORK_PROFILES, id);
}

export function resolveNetworkProfile(id) {
  if (!isSupportedNetwork(id)) {
    throw new Error(`KASPA_NETWORK must be one of ${Object.keys(NETWORK_PROFILES).join(', ')}`);
  }
  return NETWORK_PROFILES[id];
}
