import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGameFeePublicKey } from './protocol.js';
import { resolveNetworkProfile } from './network.js';

export function readServerConfig(env = process.env) {
  const port = Number.parseInt(env.PORT ?? '3000', 10);
  const metricsPort = Number.parseInt(env.METRICS_PORT ?? '9464', 10);
  const profile = resolveNetworkProfile(env.KASPA_NETWORK);
  const maxRequestBytes = Number.parseInt(env.MAX_REQUEST_BYTES ?? '1000000', 10);
  const rateLimitPerMinute = Number.parseInt(env.RATE_LIMIT_PER_MINUTE ?? '300', 10);
  if (!isPort(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  if (!isPort(metricsPort) || metricsPort < 1 || metricsPort > 65535 || metricsPort === port) throw new Error('METRICS_PORT must be a valid port distinct from PORT');
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1) throw new Error('MAX_REQUEST_BYTES must be a positive integer');
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1) throw new Error('RATE_LIMIT_PER_MINUTE must be a positive integer');
  return {
    port, metricsPort, network: profile, bot: resolveBotConfig(env, profile.id),
    gameFeePublicKey: resolveGameFeePublicKey(env, profile.id), maxRequestBytes, rateLimitPerMinute,
    trustedProxy: env.TRUST_PROXY === 'true', storePath: resolveStorePath(env, profile),
    feedbackSpillPath: env.FEEDBACK_SPILL_PATH ?? join('.data', 'feedback-spill.json'),
    paths: { publicRoot: fileURLToPath(new URL('../public/', import.meta.url)), sourceRoot: fileURLToPath(new URL('./', import.meta.url)), covenantRoot: fileURLToPath(new URL('../covenant/', import.meta.url)), vendorRoot: fileURLToPath(new URL('../vendor/', import.meta.url)) },
  };
}

function isPort(value) { return Number.isInteger(value); }

// The fallback bot is optional and off unless its funded private key is set.
// The key name is network-qualified (`BOT_PRIVATE_KEY_MAINNET` or
// `BOT_PRIVATE_KEY_TESTNET_10`, matching how the fee wallet is named) so a key
// can never be applied on the wrong network. It is the only server secret: it
// signs the bot's real transactions. When it is absent the bot is unavailable
// and is never offered to a waiting player.
function resolveBotConfig(env, networkId) {
  const envName = `BOT_PRIVATE_KEY_${networkId.toUpperCase().replaceAll('-', '_')}`;
  const privateKeyHex = String(env[envName] ?? '').trim();
  if (!privateKeyHex) return null;
  if (!/^[0-9a-f]{64}$/i.test(privateKeyHex)) throw new Error(`${envName} must be 32 bytes of hexadecimal`);
  return { privateKeyHex };
}

// The store is one JSON file on a mounted volume. In the cluster only the
// directory is configured and the file name is derived from the network, so a
// single KASPA_NETWORK switch can never point two networks at one file.
// GAME_STORE_PATH stays available as an explicit override; locally, with no
// directory set, it defaults under .data.
function resolveStorePath(env, profile) {
  if (env.GAME_STORE_PATH) return env.GAME_STORE_PATH;
  const fileName = `games-${profile.id}-v10.json`;
  if (env.GAME_STORE_DIR) return `${String(env.GAME_STORE_DIR).replace(/\/+$/, '')}/${fileName}`;
  return `.data/games-${profile.id}.json`;
}
