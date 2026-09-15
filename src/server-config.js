import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORK, resolveGameFeePublicKey } from './protocol.js';

export function readServerConfig(env = process.env) {
  const port = Number.parseInt(env.PORT ?? '3000', 10);
  const metricsPort = Number.parseInt(env.METRICS_PORT ?? '9464', 10);
  const network = env.KASPA_NETWORK ?? NETWORK;
  const maxRequestBytes = Number.parseInt(env.MAX_REQUEST_BYTES ?? '1000000', 10);
  const rateLimitPerMinute = Number.parseInt(env.RATE_LIMIT_PER_MINUTE ?? '300', 10);
  if (!isPort(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  if (!isPort(metricsPort) || metricsPort < 1 || metricsPort > 65535 || metricsPort === port) throw new Error('METRICS_PORT must be a valid port distinct from PORT');
  if (network !== NETWORK) throw new Error(`KASPA_NETWORK must be ${NETWORK}`);
  if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1) throw new Error('MAX_REQUEST_BYTES must be a positive integer');
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1) throw new Error('RATE_LIMIT_PER_MINUTE must be a positive integer');
  return {
    port, metricsPort, network, gameFeePublicKey: resolveGameFeePublicKey(env), maxRequestBytes, rateLimitPerMinute,
    trustedProxy: env.TRUST_PROXY === 'true', storePath: env.GAME_STORE_PATH ?? '.data/games-v9.json',
    feedbackSpillPath: env.FEEDBACK_SPILL_PATH ?? join('.data', 'feedback-spill.json'),
    paths: { publicRoot: fileURLToPath(new URL('../public/', import.meta.url)), sourceRoot: fileURLToPath(new URL('./', import.meta.url)), covenantRoot: fileURLToPath(new URL('../covenant/', import.meta.url)), vendorRoot: fileURLToPath(new URL('../vendor/', import.meta.url)) },
  };
}

function isPort(value) { return Number.isInteger(value); }
