import { PROTOCOL_VERSION, ProtocolError, validateGameId, validateNetwork, validateSide, stakeToSompi, MIN_STAKE_KAS, MAX_STAKE_KAS } from './protocol.js';

const PATH = '/join';
const KNOWN_KEYS = ['v', 'game', 'pk', 'c', 's', 'k', 'd', 'a'];

// Invite carries the full non-secret creation state so any client can rebuild
// the state-0 covenant and join without trusting (or even reaching) the app
// server. The commitment and side are public; the choice stays hidden behind
// the 32-byte nonce.
export function serializeInvite({ gameId, origin, creation, network }) {
  const normalizedGameId = validateGameId(gameId);
  const base = new URL(origin);
  validateNetwork(network);
  base.pathname = PATH;
  base.search = '';
  base.hash = '';
  base.searchParams.set('v', PROTOCOL_VERSION);
  base.searchParams.set('game', normalizedGameId);
  if (creation) {
    base.searchParams.set('pk', normalizeHex(creation.creatorPublicKey, 32, 'creator public key'));
    base.searchParams.set('c', normalizeHex(creation.creatorCommitment, 32, 'creator commitment'));
    base.searchParams.set('s', creation.side === 'even' ? 'e' : 'o');
    base.searchParams.set('k', String(validateStake(creation.stakeKas)));
    base.searchParams.set('d', String(normalizeDaa(creation.deadlineDaa)));
    if (creation.creatorAddress) base.searchParams.set('a', String(creation.creatorAddress));
  }
  return base.toString();
}

export function parseInvite(rawUrl, expectedOrigin, network) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ProtocolError('INVALID_INVITE', 'Invite is not a valid URL');
  }
  if (expectedOrigin && url.origin !== expectedOrigin) {
    throw new ProtocolError('INVALID_INVITE_ORIGIN', 'Invite origin is not trusted');
  }
  if (url.pathname !== PATH) {
    throw new ProtocolError('INVALID_INVITE_PATH', 'Invite path is invalid');
  }
  if (url.searchParams.get('v') !== PROTOCOL_VERSION) {
    throw new ProtocolError('UNSUPPORTED_PROTOCOL', 'Invite protocol version is unsupported');
  }
  if ([...url.searchParams.keys()].some((key) => !KNOWN_KEYS.includes(key))) {
    throw new ProtocolError('INVALID_INVITE', 'Invite contains unsupported data');
  }
  const gameId = validateGameId(url.searchParams.get('game'));
  const hasCreation = ['pk', 'c', 's', 'k', 'd'].every((key) => url.searchParams.has(key));
  const creation = hasCreation ? {
    creatorPublicKey: normalizeHex(url.searchParams.get('pk'), 32, 'creator public key'),
    creatorCommitment: normalizeHex(url.searchParams.get('c'), 32, 'creator commitment'),
    side: url.searchParams.get('s') === 'e' ? 'even' : 'odd',
    stakeKas: validateStake(Number(url.searchParams.get('k'))),
    deadlineDaa: normalizeDaa(url.searchParams.get('d')),
    creatorAddress: url.searchParams.get('a') || null,
  } : null;
  return { protocolVersion: PROTOCOL_VERSION, network: validateNetwork(network), gameId, creation };
}

function validateStake(value) {
  if (!Number.isInteger(value) || value < MIN_STAKE_KAS || value > MAX_STAKE_KAS) {
    throw new ProtocolError('INVALID_STAKE', `Stake must be an integer from ${MIN_STAKE_KAS} to ${MAX_STAKE_KAS} KAS`);
  }
  stakeToSompi(value);
  return value;
}

function normalizeDaa(value) {
  if (typeof value === 'bigint' && value > 0n) return value;
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  throw new ProtocolError('INVALID_INVITE', 'Deadline DAA must be a positive integer');
}

function normalizeHex(value, bytes, name) {
  if (typeof value !== 'string' || value.length !== bytes * 2 || !/^[0-9a-f]+$/i.test(value)) {
    throw new ProtocolError('INVALID_INVITE', `${name} must be ${bytes} bytes of hexadecimal`);
  }
  return value.toLowerCase();
}
