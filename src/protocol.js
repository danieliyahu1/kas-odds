import { bech32Decode } from './hashes/bech32.mjs';

export const PROTOCOL_VERSION = 'EO/v9';
export const NETWORK = 'testnet-10';
export const ADDRESS_PREFIX = 'kaspatest';
export const MIN_STAKE_KAS = 1;
export const MAX_STAKE_KAS = 1_000_000;
export const SOMPI_PER_KAS = 100_000_000n;
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

export class ProtocolError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

function assertStakeSompi(value, name = 'stake sompi') {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new ProtocolError('INVALID_STAKE', `${name} must be a positive bigint`);
  }
  return value;
}

export function stakeToSompi(stakeKas) {
  if (!Number.isInteger(stakeKas) || stakeKas < MIN_STAKE_KAS || stakeKas > MAX_STAKE_KAS) {
    throw new ProtocolError('INVALID_STAKE', `Stake must be an integer from ${MIN_STAKE_KAS} to ${MAX_STAKE_KAS} KAS`);
  }
  return BigInt(stakeKas) * SOMPI_PER_KAS;
}

// Complete per-player lock escrowed into the covenant: the entered stake.
export function playerLockSompi(stakeSompi) {
  const stake = assertStakeSompi(stakeSompi);
  if (stake < MIN_STAKE_SOMPI) {
    throw new ProtocolError('INVALID_STAKE', `Stake must be at least ${MIN_STAKE_KAS} KAS`);
  }
  return stake;
}

// Gross pot held by the joined covenant: both players' locks.
export function grossPotSompi(stakeSompi) {
  return assertStakeSompi(stakeSompi) * 2n;
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
export function validateGameFeeAddress(value, name = 'game fee address') {
  if (typeof value !== 'string' || !value.startsWith(`${ADDRESS_PREFIX}:`)) {
    throw new ProtocolError('INVALID_GAME_FEE', `${name} must be a ${ADDRESS_PREFIX}: wallet address`);
  }
  let decoded;
  try {
    decoded = bech32Decode(value);
  } catch {
    throw new ProtocolError('INVALID_GAME_FEE', `${name} must be a valid ${ADDRESS_PREFIX} address`);
  }
  if (decoded.prefix !== ADDRESS_PREFIX || decoded.version !== 0 || decoded.payload.length !== 32) {
    throw new ProtocolError('INVALID_GAME_FEE', `${name} must be a version-0 (PubKey) ${ADDRESS_PREFIX} address`);
  }
  return Buffer.from(decoded.payload).toString('hex');
}

export function resolveGameFeePublicKey(env) {
  if (env.GAME_FEE_ADDRESS) return validateGameFeeAddress(env.GAME_FEE_ADDRESS);
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
  if (network !== NETWORK) {
    throw new ProtocolError('WRONG_NETWORK', `Expected ${NETWORK}`);
  }
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
