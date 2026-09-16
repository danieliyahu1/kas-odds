import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { ProtocolError } from './protocol.js';
import { DEFAULT_NETWORK_PROFILE } from './network.js';

const CONTENT_TYPES = { '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml; charset=utf-8' };
const CONTENT_SECURITY_POLICY = ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self' blob:", "child-src 'self' blob:", "style-src 'self'", "img-src 'self' data:", "font-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"] .join('; ');

export function createHttpApplication({ gameService, store, relay, metrics, feedbackService, mutatingLimiter, feedbackLimiter, paths, maxRequestBytes, trustedProxy = false, startedAt = new Date().toISOString(), wakeAutomaticSettlementLoop = () => {}, logger = console, network = DEFAULT_NETWORK_PROFILE }) {
  const requestHandler = (req, res) => {
    const requestId = randomUUID();
    const trace = { requestId, requestBytesRead: 0, contentLength: req.headers['content-length'] ?? undefined };
    res.setHeader('x-request-id', requestId);
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const route = routeLabel(pathname);
    const startedAtMs = performance.now();
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      const durationSeconds = (performance.now() - startedAtMs) / 1000;
      metrics.recordHttp({ method: req.method ?? 'GET', route, status: res.statusCode, durationSeconds });
      const fields = { requestId, method: req.method ?? 'GET', route, status: res.statusCode, requestBytesRead: trace.requestBytesRead, contentLength: trace.contentLength, durationMs: Math.round(durationSeconds * 1000) };
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
    res.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
    void routeRequest(req, res, pathname, trace).catch((error) => sendError(res, error, { route, requestId }, logger));
  };

  const metricsHandler = (req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/metrics') return sendText(res, 200, metrics.render(), 'text/plain; version=0.0.4; charset=utf-8');
    return sendJson(res, 404, { error: 'not_found' });
  };

  async function routeRequest(req, res, pathname, trace) {
    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      const decision = mutatingLimiter.check(clientAddress(req, trustedProxy));
      if (!decision.allowed) {
        res.setHeader('retry-after', String(decision.retryAfterSeconds));
        return sendJson(res, 429, { error: 'RATE_LIMITED', message: 'Too many requests; slow down and retry shortly' });
      }
    }
    if (pathname === '/healthz') return sendJson(res, 200, { ok: true, service: 'kaspa-even-odd', network: network.id, startedAt });
    if (pathname === '/readyz') {
      try { await store.health(); return sendJson(res, 200, { ok: true, service: 'kaspa-even-odd', network: network.id, startedAt }); }
      catch { return sendJson(res, 503, { ok: false, service: 'kaspa-even-odd', error: 'STORAGE_UNAVAILABLE' }); }
    }
    if (req.method === 'GET' && pathname === '/api/config') return sendJson(res, 200, await gameService.networkStatus());
    if (req.method === 'POST' && pathname === '/api/feedback') {
      const decision = feedbackLimiter.check(clientAddress(req, trustedProxy));
      if (!decision.allowed) { res.setHeader('retry-after', String(decision.retryAfterSeconds)); return sendJson(res, 429, { error: 'RATE_LIMITED', message: 'Too many submissions; please wait a bit before sending more feedback' }); }
      return sendJson(res, 202, await feedbackService.submit(await readJson(req, maxRequestBytes, trace)));
    }
    if (req.method === 'POST' && pathname === '/api/games/prepare') return sendJson(res, 200, await gameService.prepareCreation(await readJson(req, maxRequestBytes, trace)));
    if (req.method === 'POST' && pathname === '/api/games/submit') { const result = await gameService.submitCreation(await readJson(req, maxRequestBytes, trace)); wakeAutomaticSettlementLoop(); return sendJson(res, 202, result); }
    if (req.method === 'POST' && pathname === '/api/matchmaking/join') return sendJson(res, 200, await gameService.joinMatchmaking(await readJson(req, maxRequestBytes, trace)));
    const matchStatus = pathname.match(/^\/api\/matchmaking\/([0-9a-f-]{36})$/i);
    const matchLeave = pathname.match(/^\/api\/matchmaking\/([0-9a-f-]{36})\/leave$/i);
    if (req.method === 'GET' && matchStatus) return sendJson(res, 200, await gameService.matchmakingStatus(matchStatus[1], new URL(req.url ?? '/', 'http://localhost').searchParams.get('address')));
    if (req.method === 'POST' && matchLeave) { const body = await readJson(req, maxRequestBytes, trace); return sendJson(res, 200, await gameService.leaveMatchmaking(matchLeave[1], body.address)); }
    const gameMatch = pathname.match(/^\/api\/games\/([0-9a-f]{64})$/i);
    const joinMatch = pathname.match(/^\/api\/games\/([0-9a-f]{64})\/join\/(prepare|submit)$/i);
    const revealMatch = pathname.match(/^\/api\/games\/([0-9a-f]{64})\/reveal\/(prepare|submit)$/i);
    const actionMatch = pathname.match(/^\/api\/games\/([0-9a-f]{64})\/creator_refund\/(prepare|submit)$/i);
    if (req.method === 'POST' && joinMatch?.[2] === 'prepare') return sendJson(res, 200, await gameService.prepareJoin(joinMatch[1], await readJson(req, maxRequestBytes, trace)));
    if (req.method === 'POST' && joinMatch?.[2] === 'submit') { const result = await gameService.submitJoin(joinMatch[1], await readJson(req, maxRequestBytes, trace)); wakeAutomaticSettlementLoop(); return sendJson(res, 202, result); }
    if (req.method === 'POST' && revealMatch?.[2] === 'prepare') return sendJson(res, 200, await gameService.prepareReveal(revealMatch[1], await readJson(req, maxRequestBytes, trace)));
    if (req.method === 'POST' && revealMatch?.[2] === 'submit') { const result = await gameService.submitReveal(revealMatch[1], await readJson(req, maxRequestBytes, trace)); wakeAutomaticSettlementLoop(); return sendJson(res, 202, result); }
    if (req.method === 'POST' && actionMatch?.[2] === 'prepare') return sendJson(res, 200, await gameService.prepareSafetyAction(actionMatch[1], 'creator_refund', await readJson(req, maxRequestBytes, trace)));
    if (req.method === 'POST' && actionMatch?.[2] === 'submit') return sendJson(res, 202, await gameService.submitSafetyAction(actionMatch[1], 'creator_refund', await readJson(req, maxRequestBytes, trace)));
    if (req.method === 'GET' && gameMatch) return sendJson(res, 200, await gameService.readGame(gameMatch[1]));
    const relayMatch = pathname.match(/^\/api\/relay\/([0-9a-f]{64})$/i);
    if (relayMatch) {
      const relayId = relayMatch[1].toLowerCase();
      if (req.method === 'POST') { relay.set(relayId, await readJson(req, maxRequestBytes, trace)); metrics.setRelayEntries(relay.size()); return sendJson(res, 200, { ok: true }); }
      if (req.method === 'GET') { const payload = relay.get(relayId); metrics.setRelayEntries(relay.size()); return payload ? sendJson(res, 200, payload) : sendJson(res, 404, { error: 'not_found' }); }
    }
    if (req.method === 'GET' && ['/', '/host', '/rival', '/join', '/game'].includes(pathname)) { if (pathname === '/') metrics.recordPageVisit(); return serveFile(paths.publicRoot, 'index.html', res); }
    if (req.method === 'GET' && /^\/(app|styles)\.\w+$/.test(pathname)) return serveFile(paths.publicRoot, pathname.slice(1), res);
    if (req.method === 'GET' && (pathname === '/icon.svg' || pathname === '/favicon.ico')) return serveFile(paths.publicRoot, 'icon.svg', res);
    const publicModule = pathname.match(/^\/([A-Za-z0-9_-]+\.(?:js|mjs))$/);
    if (req.method === 'GET' && publicModule) return serveFile(paths.publicRoot, publicModule[1], res);
    const sourceModule = pathname.match(/^\/src\/(.+\.(?:js|mjs))$/i);
    if (req.method === 'GET' && sourceModule) return serveFile(paths.sourceRoot, sourceModule[1], res);
    const vendorFile = pathname.match(/^\/vendor\/(.+\.(?:js|mjs|wasm|json))$/i);
    if (req.method === 'GET' && vendorFile) return serveFile(paths.vendorRoot, vendorFile[1], res);
    if (req.method === 'GET' && pathname === '/covenant/even_odd.template.artifact.json') return serveFile(paths.covenantRoot, 'even_odd.template.artifact.json', res);
    if (req.method === 'GET' && pathname === '/covenant/pins.json') return serveFile(paths.covenantRoot, 'pins.json', res);
    return sendJson(res, 404, { error: 'not_found' });
  }

  return { requestHandler, metricsHandler };
}

function readJson(req, maxRequestBytes, trace) {
  return new Promise((resolve, reject) => {
    let body = ''; let size = 0; let settled = false;
    const fail = (error) => { if (settled) return; settled = true; trace.requestBytesRead = size; req.resume(); reject(error); };
    req.setEncoding('utf8');
    req.on('data', (chunk) => { if (settled) return; size += Buffer.byteLength(chunk); if (size > maxRequestBytes) return fail(new ProtocolError('REQUEST_TOO_LARGE', 'Request body is too large')); body += chunk; });
    req.on('end', () => { if (settled) return; settled = true; trace.requestBytesRead = size; try { resolve(JSON.parse(body || '{}')); } catch { reject(new ProtocolError('INVALID_JSON', 'Request body must be valid JSON')); } });
    req.on('error', fail); req.on('aborted', () => fail(new ProtocolError('REQUEST_ABORTED', 'Request was aborted')));
  });
}

function sendError(res, error, context, logger) {
  if (res.writableEnded || res.destroyed) return;
  const code = error?.code ?? 'INTERNAL_ERROR';
  const clientError = error instanceof ProtocolError || ['INVALID_JSON', 'REQUEST_TOO_LARGE', 'RELAY_PAYLOAD_TOO_LARGE', 'REQUEST_ABORTED'].includes(code);
  const notFound = ['GAME_NOT_FOUND', 'PREPARATION_NOT_FOUND', 'MATCH_NOT_FOUND'].includes(code);
  res.kaspaError = { code, message: error?.message ?? 'Operation failed' };
  const fields = { requestId: context.requestId, route: context.route, code, message: error?.message };
  if (error?.cause) logger.error('rpc_transaction_rejected', { ...fields, nodeMessage: error.cause?.message ?? String(error.cause), ...error.transactionDiagnostics });
  else if (clientError) logger.warn('client_request_rejected', fields);
  else logger.error('server_error', { ...fields, stack: error?.stack });
  sendJson(res, responseStatus(code, clientError, notFound), { error: code, message: clientError ? error.message : 'Kaspa backend is unavailable', requestId: context.requestId });
}

function responseStatus(code, clientError, notFound) {
  if (notFound) return 404;
  if (code === 'REQUEST_TOO_LARGE') return 413;
  return clientError ? 400 : 502;
}

function sendJson(res, status, body) { if (res.writableEnded || res.destroyed) return; res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function sendText(res, status, body, contentType) { res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' }); res.end(body); }
async function serveFile(root, requestPath, res) { const safePath = normalize(requestPath).replace(/^([.][.][\\/])+/, ''); try { const body = await readFile(join(root, safePath)); res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(safePath)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); res.end(body); } catch (error) { if (error?.code === 'ENOENT') return sendJson(res, 404, { error: 'not_found' }); throw error; } }
function routeLabel(pathname) {
  if (pathname === '/healthz') return '/healthz'; if (pathname === '/readyz') return '/readyz'; if (pathname === '/api/config') return '/api/config'; if (pathname === '/api/feedback') return '/api/feedback'; if (pathname === '/api/games/prepare') return '/api/games/prepare'; if (pathname === '/api/games/submit') return '/api/games/submit'; if (pathname === '/api/matchmaking/join') return '/api/matchmaking/join'; if (/^\/api\/matchmaking\/[0-9a-f-]{36}\/leave$/i.test(pathname)) return '/api/matchmaking/:id/leave'; if (/^\/api\/matchmaking\/[0-9a-f-]{36}$/i.test(pathname)) return '/api/matchmaking/:id'; if (/^\/api\/games\/[0-9a-f]{64}\/join\/(prepare|submit)$/i.test(pathname)) return '/api/games/:id/join/:step'; if (/^\/api\/games\/[0-9a-f]{64}\/reveal\/(prepare|submit)$/i.test(pathname)) return '/api/games/:id/reveal/:step'; if (/^\/api\/games\/[0-9a-f]{64}\/creator_refund\/(prepare|submit)$/i.test(pathname)) return '/api/games/:id/:action/:step'; if (/^\/api\/games\/[0-9a-f]{64}$/i.test(pathname)) return '/api/games/:id'; if (/^\/api\/relay\/[0-9a-f]{64}$/i.test(pathname)) return '/api/relay/:id'; if (['/', '/host', '/rival', '/join', '/game'].includes(pathname)) return 'page'; if (/^\/(app|styles)\.\w+$/.test(pathname) || /^\/[A-Za-z0-9_-]+\.(?:js|mjs)$/.test(pathname)) return 'asset'; if (pathname.startsWith('/src/')) return 'source'; if (pathname.startsWith('/vendor/')) return 'vendor'; if (pathname.startsWith('/covenant/')) return 'covenant'; return 'other';
}
function clientAddress(req, trustedProxy) { if (trustedProxy) { const forwarded = req.headers['x-forwarded-for']; if (typeof forwarded === 'string' && forwarded.length > 0) return forwarded.split(',')[0].trim(); } return req.socket.remoteAddress ?? 'unknown'; }
function isStaticRoute(route) { return ['asset', 'source', 'vendor', 'covenant'].includes(route); }
