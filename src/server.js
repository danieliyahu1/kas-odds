import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackendGameService } from './backend-game-service.js';
import { BackendGameStore } from './backend-game-store.js';
import { NETWORK, PROTOCOL_VERSION, ProtocolError, resolveGameFeePublicKey } from './protocol.js';
import { WrpcClient } from './wrpc-client.js';
import { Metrics, withRpcMetrics } from './metrics.js';
import { RelayStore } from './relay-store.js';
import { RateLimiter } from './rate-limit.js';
import { FeedbackService, FeedbackSpill, TelegramFeedback } from './feedback.js';
import { logger } from './logger.js';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const metricsPort = Number.parseInt(process.env.METRICS_PORT ?? '9464', 10);
const configuredNetwork = process.env.KASPA_NETWORK ?? NETWORK;
const gameFeePublicKey = resolveGameFeePublicKey(process.env);
const maxRequestBytes = Number.parseInt(process.env.MAX_REQUEST_BYTES ?? '1000000', 10);
const rateLimitPerMinute = Number.parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? '300', 10);
const trustedProxy = process.env.TRUST_PROXY === 'true';
const startedAt = new Date().toISOString();
const publicRoot = fileURLToPath(new URL('../public/', import.meta.url));
const sourceRoot = fileURLToPath(new URL('./', import.meta.url));
const covenantRoot = fileURLToPath(new URL('../covenant/', import.meta.url));
const vendorRoot = fileURLToPath(new URL('../vendor/', import.meta.url));
const contentTypes = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml; charset=utf-8' };

// Defense-in-depth against XSS reading the browser-local reveal secret. Scripts
// are same-origin only (no inline/third-party), with 'wasm-unsafe-eval' for the
// pinned Rusty Kaspa SDK. The thin browser client talks only to this server
// (connect-src 'self'); all Kaspa chain communication happens server-side.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

if (!isPort(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
if (!isPort(metricsPort) || metricsPort < 1 || metricsPort > 65535 || metricsPort === port) throw new Error('METRICS_PORT must be a valid port distinct from PORT');
if (configuredNetwork !== NETWORK) throw new Error(`KASPA_NETWORK must be ${NETWORK}`);
if (!Number.isInteger(maxRequestBytes) || maxRequestBytes < 1) throw new Error('MAX_REQUEST_BYTES must be a positive integer');
if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1) throw new Error('RATE_LIMIT_PER_MINUTE must be a positive integer');

const metrics = new Metrics();
metrics.setProductInfo(PROTOCOL_VERSION);
const chainClient = new WrpcClient({ network: configuredNetwork });
const rpc = withRpcMetrics(chainClient, metrics);
const store = new BackendGameStore(process.env.GAME_STORE_PATH ?? '.data/games.json', { metrics });
const gameService = new BackendGameService({ rpc, store, metrics, gameFeePublicKey });

// Optional, untrusted relay: clients publish non-secret game state here so the
// opponent can discover it. Every payload is re-verified on-chain by the
// receiving client, so the relay cannot alter the game.
const relay = new RelayStore();
const mutatingLimiter = new RateLimiter({ limit: rateLimitPerMinute, windowMs: 60_000 });

// Anonymous feedback: the browser posts a short message, and the server
// forwards it to a private Telegram chat. The bot token and chat id are
// runtime-only configuration; when they are missing the app still accepts the
// feedback and logs a warning so a missing bot never breaks the app.
const feedbackDeliverer = new TelegramFeedback({
  botToken: process.env.TELEGRAM_FEEDBACK_BOT_TOKEN,
  chatId: process.env.TELEGRAM_FEEDBACK_CHAT_ID,
  endpoint: process.env.FEEDBACK_TELEGRAM_SEND_URL,
});
const feedbackSpill = new FeedbackSpill({
  filePath: process.env.FEEDBACK_SPILL_PATH ?? join('.data', 'feedback-spill.json'),
});
const feedbackService = new FeedbackService({
  deliverer: feedbackDeliverer,
  spill: feedbackSpill,
  metrics,
  logger,
});
// Retry accepted-but-undelivered feedback (crashes, Telegram outages) on
// startup and then periodically until it lands.
if (feedbackDeliverer.enabled) {
  void feedbackService.drainPending().catch((error) => logger.debug('feedback_drain_failed', { message: error?.message }));
  const feedbackDrainTimer = setInterval(() => { void feedbackService.drainPending().catch((error) => logger.debug('feedback_drain_failed', { message: error?.message })); }, 120_000);
  feedbackDrainTimer.unref();
} else {
  logger.warn('feedback_delivery_disabled', { reason: 'TELEGRAM_FEEDBACK_BOT_TOKEN or TELEGRAM_FEEDBACK_CHAT_ID is not set' });
}
// Long-window per-client cap for feedback (the shared limiter still applies too).
const feedbackLimiter = new RateLimiter({ limit: 5, windowMs: 10 * 60_000 });

await store.init();

// Warm the node connection in the background so the first real chain call is
// not the slow one. Never block startup or fail it on a cold node.
void chainClient.connect().catch((error) => logger.debug('rpc_warmup_failed', { message: error?.message }));

// Seed the matchmaking and game-state gauges, and keep them fresh across
// restarts. Game status changes during live sessions update them directly.
void gameService.refreshTelemetry().catch((error) => logger.debug('telemetry_refresh_failed', { message: error?.message }));
const telemetryTimer = setInterval(() => { void gameService.refreshTelemetry().catch((error) => logger.debug('telemetry_refresh_failed', { message: error?.message })); }, 60_000);
telemetryTimer.unref();

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const route = routeLabel(pathname);
  const startedAtMs = performance.now();
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    const durationSeconds = (performance.now() - startedAtMs) / 1000;
    metrics.recordHttp({ method: req.method ?? 'GET', route, status: res.statusCode, durationSeconds });
    const fields = {
      method: req.method ?? 'GET',
      route,
      status: res.statusCode,
      durationMs: Math.round(durationSeconds * 1000),
      ...(res.kaspaError ?? {}),
    };
    if (res.statusCode >= 500) logger.error('http_request', fields);
    else if (res.statusCode >= 400) logger.warn('http_request', fields);
    else if (isStaticRoute(route)) logger.debug('http_request', fields);
    else logger.info('http_request', fields);
  };
  res.on('finish', record);
  res.on('close', record);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', contentSecurityPolicy);
  void routeRequest(req, res, pathname).catch((error) => sendError(res, error, { route, pathname }));
});

async function routeRequest(req, res, pathname) {
  if (req.method === 'POST' && pathname.startsWith('/api/')) {
    const decision = mutatingLimiter.check(clientAddress(req));
    if (!decision.allowed) {
      res.setHeader('retry-after', String(decision.retryAfterSeconds));
      return sendJson(res, 429, { error: 'RATE_LIMITED', message: 'Too many requests; slow down and retry shortly' });
    }
  }

  if (pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, service: 'kaspa-even-odd', network: NETWORK, startedAt });
  }
  if (pathname === '/readyz') {
    try {
      await store.health();
      return sendJson(res, 200, { ok: true, service: 'kaspa-even-odd', network: NETWORK, startedAt });
    } catch {
      return sendJson(res, 503, { ok: false, service: 'kaspa-even-odd', error: 'STORAGE_UNAVAILABLE' });
    }
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, await gameService.networkStatus());
  }
  if (req.method === 'POST' && pathname === '/api/feedback') {
    const decision = feedbackLimiter.check(clientAddress(req));
    if (!decision.allowed) {
      res.setHeader('retry-after', String(decision.retryAfterSeconds));
      return sendJson(res, 429, { error: 'RATE_LIMITED', message: 'Too many submissions; please wait a bit before sending more feedback' });
    }
    return sendJson(res, 202, await feedbackService.submit(await readJson(req)));
  }
  if (req.method === 'POST' && pathname === '/api/games/prepare') {
    return sendJson(res, 200, await gameService.prepareCreation(await readJson(req)));
  }
  if (req.method === 'POST' && pathname === '/api/games/submit') {
    return sendJson(res, 202, await gameService.submitCreation(await readJson(req)));
  }
  if (req.method === 'POST' && pathname === '/api/matchmaking/join') {
    return sendJson(res, 200, await gameService.joinMatchmaking(await readJson(req)));
  }
  const matchStatus = pathname.match(/^\/api\/matchmaking\/([0-9a-f-]{36})$/i);
  const matchLeave = pathname.match(/^\/api\/matchmaking\/([0-9a-f-]{36})\/leave$/i);
  if (req.method === 'GET' && matchStatus) {
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    return sendJson(res, 200, await gameService.matchmakingStatus(matchStatus[1], query.get('address')));
  }
  if (req.method === 'POST' && matchLeave) {
    const body = await readJson(req);
    return sendJson(res, 200, await gameService.leaveMatchmaking(matchLeave[1], body.address));
  }
  const gameMatch = pathname.match(/^\/api\/games\/([0-9a-f]{64})$/i);
  const joinMatch = pathname.match(/^\/api\/games\/([0-9a-f]{64})\/join\/(prepare|submit)$/i);
  const revealMatch = pathname.match(/^\/api\/games\/([0-9a-f]{64})\/reveal\/(prepare|submit)$/i);
  const actionMatch = pathname.match(/^\/api\/games\/([0-9a-f]{64})\/(creator_refund|fallback_claim|refund_player)\/(prepare|submit)$/i);
  if (req.method === 'POST' && joinMatch?.[2] === 'prepare') {
    return sendJson(res, 200, await gameService.prepareJoin(joinMatch[1], await readJson(req)));
  }
  if (req.method === 'POST' && joinMatch?.[2] === 'submit') {
    return sendJson(res, 202, await gameService.submitJoin(joinMatch[1], await readJson(req)));
  }
  if (req.method === 'POST' && revealMatch?.[2] === 'prepare') {
    return sendJson(res, 200, await gameService.prepareReveal(revealMatch[1], await readJson(req)));
  }
  if (req.method === 'POST' && revealMatch?.[2] === 'submit') {
    return sendJson(res, 202, await gameService.submitReveal(revealMatch[1], await readJson(req)));
  }
  if (req.method === 'POST' && actionMatch?.[3] === 'prepare') {
    return sendJson(res, 200, await gameService.prepareSafetyAction(actionMatch[1], actionMatch[2], await readJson(req)));
  }
  if (req.method === 'POST' && actionMatch?.[3] === 'submit') {
    return sendJson(res, 202, await gameService.submitSafetyAction(actionMatch[1], actionMatch[2], await readJson(req)));
  }
  if (req.method === 'GET' && gameMatch) {
    return sendJson(res, 200, await gameService.readGame(gameMatch[1]));
  }

  const relayMatch = pathname.match(/^\/api\/relay\/([0-9a-f]{64})$/i);
  if (relayMatch) {
    const relayId = relayMatch[1].toLowerCase();
    if (req.method === 'POST') {
      relay.set(relayId, await readJson(req));
      metrics.setRelayEntries(relay.size());
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET') {
      const payload = relay.get(relayId);
      metrics.setRelayEntries(relay.size());
      return payload ? sendJson(res, 200, payload) : sendJson(res, 404, { error: 'not_found' });
    }
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/host' || pathname === '/rival' || pathname === '/join' || pathname === '/game')) {
    if (pathname === '/') metrics.recordPageVisit();
    return serveFile(publicRoot, 'index.html', res);
  }
  if (req.method === 'GET' && /^\/(app|styles)\.\w+$/.test(pathname)) {
    return serveFile(publicRoot, pathname.slice(1), res);
  }
  // Serve the SVG favicon for both the declared icon path and the implicit
  // browser request, so the tab icon loads instead of 404ing.
  if (req.method === 'GET' && (pathname === '/icon.svg' || pathname === '/favicon.ico')) {
    return serveFile(publicRoot, 'icon.svg', res);
  }
  const publicModule = pathname.match(/^\/([A-Za-z0-9_-]+\.(?:js|mjs))$/);
  if (req.method === 'GET' && publicModule) {
    return serveFile(publicRoot, publicModule[1], res);
  }
  const sourceModule = pathname.match(/^\/src\/(.+\.(?:js|mjs))$/i);
  if (req.method === 'GET' && sourceModule) {
    return serveFile(sourceRoot, sourceModule[1], res);
  }
  const vendorFile = pathname.match(/^\/vendor\/(.+\.(?:js|mjs|wasm|json))$/i);
  if (req.method === 'GET' && vendorFile) {
    return serveFile(vendorRoot, vendorFile[1], res);
  }
  if (req.method === 'GET' && pathname === '/covenant/even_odd.template.artifact.json') {
    return serveFile(covenantRoot, 'even_odd.template.artifact.json', res);
  }
  if (req.method === 'GET' && pathname === '/covenant/pins.json') {
    return serveFile(covenantRoot, 'pins.json', res);
  }
  return sendJson(res, 404, { error: 'not_found' });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(error);
    };
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (settled) return;
      size += Buffer.byteLength(chunk);
      if (size > maxRequestBytes) return fail(new ProtocolError('REQUEST_TOO_LARGE', 'Request body is too large'));
      body += chunk;
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new ProtocolError('INVALID_JSON', 'Request body must be valid JSON')); }
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new ProtocolError('REQUEST_ABORTED', 'Request was aborted')));
  });
}

function sendError(res, error, context = {}) {
  if (res.writableEnded || res.destroyed) return;
  const code = error?.code ?? 'INTERNAL_ERROR';
  const clientError = error instanceof ProtocolError || ['INVALID_JSON', 'REQUEST_TOO_LARGE', 'RELAY_PAYLOAD_TOO_LARGE', 'REQUEST_ABORTED'].includes(code);
  const notFound = ['GAME_NOT_FOUND', 'PREPARATION_NOT_FOUND', 'MATCH_NOT_FOUND'].includes(code);
  res.kaspaError = { code, message: error?.message ?? 'Operation failed' };
  if (error?.cause) {
    logger.error('rpc_transaction_rejected', {
      code,
      route: context.route,
      path: context.pathname,
      nodeMessage: error.cause?.message ?? String(error.cause),
    });
  } else if (!clientError) {
    logger.error('server_error', { code, message: error?.message, stack: error?.stack });
  }
  sendJson(res, notFound ? 404 : clientError ? 400 : 502, {
    error: code,
    message: clientError ? error.message : 'Kaspa testnet10 backend is unavailable',
  });
}

function sendJson(res, status, body) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveFile(root, requestPath, res) {
  const safePath = normalize(requestPath).replace(/^([.][.][\\/])+/, '');
  try {
    const body = await readFile(join(root, safePath));
    res.writeHead(200, { 'content-type': contentTypes[extname(safePath)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
  }
}

function routeLabel(pathname) {
  if (pathname === '/healthz') return '/healthz';
  if (pathname === '/readyz') return '/readyz';
  if (pathname === '/api/config') return '/api/config';
  if (pathname === '/api/feedback') return '/api/feedback';
  if (pathname === '/api/games/prepare') return '/api/games/prepare';
  if (pathname === '/api/games/submit') return '/api/games/submit';
  if (pathname === '/api/matchmaking/join') return '/api/matchmaking/join';
  if (/^\/api\/matchmaking\/[0-9a-f-]{36}\/leave$/i.test(pathname)) return '/api/matchmaking/:id/leave';
  if (/^\/api\/matchmaking\/[0-9a-f-]{36}$/i.test(pathname)) return '/api/matchmaking/:id';
  if (/^\/api\/games\/[0-9a-f]{64}\/(join|reveal)\/(prepare|submit)$/i.test(pathname)) return '/api/games/:id/:stage/:step';
  if (/^\/api\/games\/[0-9a-f]{64}\/(creator_refund|fallback_claim|refund_player)\/(prepare|submit)$/i.test(pathname)) return '/api/games/:id/:action/:step';
  if (/^\/api\/games\/[0-9a-f]{64}$/i.test(pathname)) return '/api/games/:id';
  if (/^\/api\/relay\/[0-9a-f]{64}$/i.test(pathname)) return '/api/relay/:id';
  if (pathname === '/' || pathname === '/host' || pathname === '/rival' || pathname === '/join' || pathname === '/game') return 'page';
  if (/^\/(app|styles)\.\w+$/.test(pathname)) return 'asset';
  if (/^\/[A-Za-z0-9_-]+\.(?:js|mjs)$/.test(pathname)) return 'asset';
  if (pathname.startsWith('/src/')) return 'source';
  if (pathname.startsWith('/vendor/')) return 'vendor';
  if (pathname.startsWith('/covenant/')) return 'covenant';
  return 'other';
}

function isStaticRoute(route) {
  return ['asset', 'source', 'vendor', 'covenant'].includes(route);
}

function clientAddress(req) {
  if (trustedProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function isPort(value) {
  return Number.isInteger(value);
}

server.requestTimeout = 30_000;
server.headersTimeout = 20_000;
server.keepAliveTimeout = 5_000;

const metricsServer = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(metrics.render());
  }
  return sendJson(res, 404, { error: 'not_found' });
});
metricsServer.requestTimeout = 10_000;
metricsServer.headersTimeout = 5_000;

server.listen(port, '0.0.0.0');
metricsServer.listen(metricsPort, '0.0.0.0');

logger.info('server_started', {
  port,
  metricsPort,
  network: configuredNetwork,
  gameFeePublicKey,
  storePath: process.env.GAME_STORE_PATH ?? '.data/games.json',
  feedbackTelegram: feedbackDeliverer.enabled,
  feedbackSpillPath: process.env.FEEDBACK_SPILL_PATH ?? join('.data', 'feedback-spill.json'),
  logLevel: logger.level,
  pid: process.pid,
});

function shutdown(signal) {
  logger.info('server_stopping', { signal });
  server.close(async () => {
    try { await rpc.disconnect(); } catch (disconnectError) { logger.error('rpc_disconnect_failed', { message: disconnectError?.message, stack: disconnectError?.stack }); }
    metricsServer.close(() => { logger.info('server_stopped'); process.exit(0); });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
