import { createServer } from 'node:http';
import { join } from 'node:path';
import { BackendGameService } from './backend-game-service.js';
import { BackendGameStore } from './backend-game-store.js';
import { PROTOCOL_VERSION } from './protocol.js';
import { WrpcClient } from './wrpc-client.js';
import { Metrics, withRpcMetrics } from './metrics.js';
import { RelayStore } from './relay-store.js';
import { RateLimiter } from './rate-limit.js';
import { FeedbackService, FeedbackSpill, TelegramFeedback } from './feedback.js';
import { logger } from './logger.js';
import { KaspaChainAdapter } from './chain-adapter.js';
import { createHttpApplication } from './http-application.js';
import { readServerConfig } from './server-config.js';
import { createServerSchedulers } from './server-schedulers.js';

const config = readServerConfig();
const network = config.network;
const startedAt = new Date().toISOString();
const metrics = new Metrics();
metrics.setProductInfo(PROTOCOL_VERSION);
const chainClient = new WrpcClient({ network: network.id });
const rpc = withRpcMetrics(chainClient, metrics);
const chain = new KaspaChainAdapter({ rpc });
const store = new BackendGameStore(config.storePath, { metrics });
const gameService = new BackendGameService({ chain, store, metrics, gameFeePublicKey: config.gameFeePublicKey, network });
const relay = new RelayStore();
const mutatingLimiter = new RateLimiter({ limit: config.rateLimitPerMinute, windowMs: 60_000 });
const feedbackDeliverer = new TelegramFeedback({ botToken: process.env.TELEGRAM_FEEDBACK_BOT_TOKEN, chatId: process.env.TELEGRAM_FEEDBACK_CHAT_ID, endpoint: process.env.FEEDBACK_TELEGRAM_SEND_URL });
const feedbackSpill = new FeedbackSpill({ filePath: config.feedbackSpillPath });
const feedbackService = new FeedbackService({ deliverer: feedbackDeliverer, spill: feedbackSpill, metrics, logger });
const feedbackLimiter = new RateLimiter({ limit: 5, windowMs: 10 * 60_000 });
const schedulers = createServerSchedulers({ gameService, feedbackService, feedbackDeliverer, chainClient, logger });
const application = createHttpApplication({ gameService, store, relay, metrics, feedbackService, mutatingLimiter, feedbackLimiter, paths: config.paths, maxRequestBytes: config.maxRequestBytes, trustedProxy: config.trustedProxy, startedAt, wakeAutomaticSettlementLoop: schedulers.wakeSettlement, logger, network });
const server = createServer(application.requestHandler);
const metricsServer = createServer(application.metricsHandler);
server.requestTimeout = 30_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 5_000;
metricsServer.requestTimeout = 10_000;
metricsServer.headersTimeout = 5_000;

await store.init();
await gameService.reconcilePendingSubmissions();
await schedulers.start();
server.listen(config.port, '0.0.0.0');
metricsServer.listen(config.metricsPort, '0.0.0.0');
logger.info('server_started', { port: config.port, metricsPort: config.metricsPort, network: network.id, gameFeePublicKey: config.gameFeePublicKey, storePath: config.storePath, feedbackTelegram: feedbackDeliverer.enabled, feedbackSpillPath: config.feedbackSpillPath, logLevel: logger.level, pid: process.pid });

function shutdown(signal) {
  logger.info('server_stopping', { signal });
  schedulers.stop();
  server.close(async () => {
    try { await rpc.disconnect(); } catch (error) { logger.error('rpc_disconnect_failed', { message: error?.message, stack: error?.stack }); }
    metricsServer.close(() => { logger.info('server_stopped'); process.exit(0); });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
