import { bech32Decode } from './hashes/bech32.mjs';
import { isSupportedNetwork, resolveNetworkProfile } from './network.js';

export const PROTOCOL_VERSION = 'EO/v10';
export const MIN_STAKE_KAS = 1;
export const MAX_STAKE_KAS = 1_000_000;
export const SOMPI_PER_KAS = 100_000_000n;
// 1 KAS = 100,000,000 sompi, so eight is the deepest exact decimal place.
export const KAS_DECIMALS = 8;
export const MIN_STAKE_SOMPI = BigInt(MIN_STAKE_KAS) * SOMPI_PER_KAS;

// Protocol v7: the entered stake IS the complete per-player lock — no extra fee
// is added on top. Both players fund `stake`, so the joined covenant holds
// `grossPot = stake * 2`. When a winner exists (second reveal or fallback claim)
// For a pot of at least 100 KAS, 1% goes to the game wallet and the winner
// receives the remainder. Smaller pots pay the winner in full. Canceled/no-
// reveal games use the creator refund path; automatic timeout settlement reserves
// the fixed network fee from the locked pot, while the game fee is never charged
// without a winner.
export const GAME_FEE_DENOMINATOR = 100n;
export const GAME_FEE_NUMERATOR = 1n;
export const GAME_FEE_MINIMUM_SOMPI = SOMPI_PER_KAS;
// Fee reserve embedded in each v9 covenant instance. At the relay floor, the
// largest timeout transaction currently measures about 7,759 grams (775,900
// sompi); this reserve leaves headroom for fee-rate movement and is deliberately
// even because refund_all splits it equally between both players.
export const AUTOMATION_FEE_SOMPI = 1_600_000n;
// A join spends the creator's covenant output before it is mined. Kaspa accepts
// that as a chained mempool transaction as long as the parent is in the pool, and
// builders describe the not-yet-mined parent with the maximum DAA score.
export const UNCONFIRMED_INPUT_DAA_SCORE = 0xffffffffffffffffn;

export const ERROR_CATEGORIES = Object.freeze({
  DOMAIN: 'domain',
  VALIDATION: 'validation',
  CONFLICT: 'conflict',
  DEPENDENCY: 'dependency',
  INTERNAL: 'internal',
});

export class ProtocolError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.category = options.category ?? categoryForCode(code);
    if (options.cause) this.cause = options.cause;
  }
}

function categoryForCode(code) {
  if (code === 'INTERNAL_ERROR') return ERROR_CATEGORIES.INTERNAL;
  if (code.startsWith('STORAGE_') || code.startsWith('RPC_') || code.startsWith('WASM_')) return ERROR_CATEGORIES.DEPENDENCY;
  if (code.startsWith('INVALID_') || code.startsWith('WRONG_') || code.startsWith('REQUEST_') || code.startsWith('FEEDBACK_')) return ERROR_CATEGORIES.VALIDATION;
  if (code.includes('ALREADY') || code.includes('PENDING') || code.includes('CONFLICT') || code === 'MATCH_NOT_READY') return ERROR_CATEGORIES.CONFLICT;
  if (code.startsWith('GAME_') || code.startsWith('MATCH_') || code.startsWith('ACTION_') || code === 'NOT_A_PLAYER') return ERROR_CATEGORIES.DOMAIN;
  return ERROR_CATEGORIES.INTERNAL;
}

function assertStakeSompi(value, name = 'stake sompi') {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new ProtocolError('INVALID_STAKE', `${name} must be a positive bigint`);
  }
  return value;
}

// Accepts any finite KAS amount from 1 to 1,000,000 (fractions allowed). Zero and
// anything else outside that range is rejected: every game is a staked game.
export function stakeToSompi(stakeKas) {
  const value = toKasNumber(stakeKas);
  if (value < MIN_STAKE_KAS || value > MAX_STAKE_KAS) {
    throw new ProtocolError('INVALID_STAKE', `Stake must be from ${MIN_STAKE_KAS} to ${MAX_STAKE_KAS} KAS`);
  }
  assertSompiPrecision(value);
  const sompi = Math.round(value * Number(SOMPI_PER_KAS));
  if (!Number.isSafeInteger(sompi) || sompi <= 0) {
    throw new ProtocolError('INVALID_STAKE', 'Stake exceeds the supported sompi precision');
  }
  return BigInt(sompi);
}

// The chain stores value in sompi (1 KAS = 100,000,000 sompi), so an amount with
// more than eight decimal places has no exact on-chain representation. Reject it
// rather than silently rounding the wager to a different amount.
function assertSompiPrecision(value) {
  const fraction = String(value).split('.')[1] ?? '';
  if (fraction.replace(/0+$/, '').length > KAS_DECIMALS) {
    throw new ProtocolError('INVALID_STAKE', `Stake supports at most ${KAS_DECIMALS} decimal places`);
  }
}

function toKasNumber(stakeKas) {
  const value = typeof stakeKas === 'string' ? Number(stakeKas) : stakeKas;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ProtocolError('INVALID_STAKE', 'Stake must be a finite number of KAS');
  }
  return value;
}

// Complete per-player lock escrowed into the covenant: the entered stake.
export function playerLockSompi(stakeSompi) {
  const stake = assertStakeSompi(stakeSompi);
  if (stake < MIN_STAKE_SOMPI) {
    throw new ProtocolError('INVALID_STAKE', `Stake must be at least ${MIN_STAKE_KAS} KAS`);
  }
  return stake;
}

// Gross pot held by the joined covenant: both players' locks. Validating the
// lock here means every fee and payout helper inherits the >= 1 KAS minimum.
export function grossPotSompi(stakeSompi) {
  return playerLockSompi(stakeSompi) * 2n;
}

// Single game fee: 1% of the total pot only when that fee is at least 1 KAS.
export function gameFeeSompi(stakeSompi) {
  const fee = grossPotSompi(stakeSompi) * GAME_FEE_NUMERATOR / GAME_FEE_DENOMINATOR;
  return fee >= GAME_FEE_MINIMUM_SOMPI ? fee : 0n;
}

// Winner payout: the gross pot minus the single game fee.
export function winnerPayoutSompi(stakeSompi) {
  return grossPotSompi(stakeSompi) - gameFeeSompi(stakeSompi);
}

export function automaticRefundPayoutSompi(stakeSompi) {
  const stake = playerLockSompi(stakeSompi);
  return stake - AUTOMATION_FEE_SOMPI / 2n;
}

export function automaticFallbackPayoutSompi(stakeSompi) {
  const payout = winnerPayoutSompi(stakeSompi) - AUTOMATION_FEE_SOMPI;
  if (payout <= 0n) throw new ProtocolError('INVALID_STAKE', 'Stake is too small for automatic settlement');
  return payout;
}

export function validateStakeInput(stakeKas) {
  const value = toKasNumber(stakeKas);
  stakeToSompi(value);
  return value;
}

// Canonical economics for a request or game record. Every on-chain value derives
// from here so the protocol, the covenant, and the display cannot drift apart.
export function resolveEconomics(source) {
  const stake = playerLockSompi(source.stakeSompi);
  return Object.freeze({
    stakeSompi: stake,
    lockSompi: stake,
    potSompi: grossPotSompi(stake),
    gameFeeSompi: gameFeeSompi(stake),
    settlementPayoutSompi: winnerPayoutSompi(stake),
    automaticFallbackPayoutSompi: automaticFallbackPayoutSompi(stake),
    refundPayoutSompi: stake,
    refundOpenPayoutSompi: stake - AUTOMATION_FEE_SOMPI,
    refundAllPayoutSompi: stake - AUTOMATION_FEE_SOMPI / 2n,
    payoutRole: 'winner',
  });
}

// The value carried by the covenant output for a given request/game.
export function covenantValueSompi(source) {
  return resolveEconomics(source).lockSompi;
}

export function validateGameFeePublicKey(value, name = 'game fee public key') {
  if (typeof value !== 'string' || !/^[0-9a-f]+$/i.test(value)) {
    throw new ProtocolError('INVALID_GAME_FEE', `${name} must be a hexadecimal x-only public key`);
  }
  const normalized = value.toLowerCase();
  if (normalized.length === 64) return normalized;
  if (normalized.length === 66 && /^(02|03)/.test(normalized)) return normalized.slice(2);
  throw new ProtocolError('INVALID_GAME_FEE', `${name} must be a 32-byte x-only or compressed public key`);
}

// Kaspa version-0 (PubKey) addresses embed the 32-byte x-only public key
// directly, so a wallet address is a valid fee-recipient configuration.
export function validateGameFeeAddress(value, addressPrefix, name = 'game fee address') {
  if (typeof value !== 'string' || !value.startsWith(`${addressPrefix}:`)) {
    throw new ProtocolError('INVALID_GAME_FEE', `${name} must be a ${addressPrefix}: wallet address`);
  }
  let decoded;
  try {
    decoded = bech32Decode(value);
  } catch {
    throw new ProtocolError('INVALID_GAME_FEE', `${name} must be a valid ${addressPrefix} address`);
  }
  if (decoded.prefix !== addressPrefix || decoded.version !== 0 || decoded.payload.length !== 32) {
    throw new ProtocolError('INVALID_GAME_FEE', `${name} must be a version-0 (PubKey) ${addressPrefix} address`);
  }
  return Buffer.from(decoded.payload).toString('hex');
}

export function resolveGameFeePublicKey(env, network) {
  const { addressPrefix } = resolveNetworkProfile(network);
  const qualifiedKey = `GAME_FEE_ADDRESS_${network.toUpperCase().replaceAll('-', '_')}`;
  const hasQualifiedFeeAddress = Object.prototype.hasOwnProperty.call(env, qualifiedKey);
  const feeAddress = hasQualifiedFeeAddress ? env[qualifiedKey] : env.GAME_FEE_ADDRESS;
  if (feeAddress) return validateGameFeeAddress(feeAddress, addressPrefix);
  if (env.GAME_FEE_PUBLIC_KEY) return validateGameFeePublicKey(env.GAME_FEE_PUBLIC_KEY);
  return null;
}

export function validateSide(side) {
  if (side !== 'even' && side !== 'odd') {
    throw new ProtocolError('INVALID_SIDE', 'Side must be even or odd');
  }
  return side;
}

export function validateNetwork(network) {
  if (!isSupportedNetwork(network)) {
    throw new ProtocolError('WRONG_NETWORK', 'Unsupported Kaspa network');
  }
  return network;
}

export function validateNetworkMatches(network, expectedId) {
  if (network !== expectedId) {
    throw new ProtocolError('WRONG_NETWORK', `Expected ${expectedId}`);
  }
  return network;
}

export function validateGameId(gameId) {
  if (typeof gameId !== 'string' || !/^[0-9a-f]{64}$/i.test(gameId)) {
    throw new ProtocolError('INVALID_GAME_ID', 'Game identifier must be a 32-byte hexadecimal value');
  }
  return gameId.toLowerCase();
}

export function validateFeeSeparation({ gameValue, feeValue }) {
  if (typeof gameValue !== 'bigint' || gameValue <= 0n) {
    throw new ProtocolError('INVALID_GAME_VALUE', 'Game output value must be positive sompi');
  }
  if (typeof feeValue !== 'bigint' || feeValue < 0n) {
    throw new ProtocolError('INVALID_FEE', 'Fee must be a non-negative sompi amount');
  }
  return { gameValue, feeValue };
}
