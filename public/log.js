// Browser-side debug logging for KasOdds.
//
// Verbose logs are opt-in: add `?debug=1` to the URL or set
// `localStorage['kasodds-debug'] = '1'` in the console. Warnings and errors are
// always emitted. Field names that could carry secrets or wallet identifiers
// are redacted before they reach the console.
const PREFIX = '[kasodds]';
const REDACTED_FIELD = /(address|nonce|key|signature|private|secret|txjson|preparedhash|commitment)/i;
const MAX_VALUE_LENGTH = 200;

let debugOverride;

export function setLogDebug(enabled) {
  debugOverride = enabled === undefined ? undefined : Boolean(enabled);
}

export function isLogDebug() {
  if (debugOverride !== undefined) return debugOverride;
  try {
    if (globalThis.location?.search) {
      if (new URLSearchParams(globalThis.location.search).get('debug') === '1') return true;
    }
  } catch { /* ignore */ }
  try {
    if (globalThis.localStorage?.getItem('kasodds-debug') === '1') return true;
  } catch { /* ignore */ }
  return false;
}

export function logDebug(event, fields) {
  if (isLogDebug()) emit('debug', event, fields);
}

export function logInfo(event, fields) {
  if (isLogDebug()) emit('info', event, fields);
}

export function logWarn(event, fields) {
  emit('warn', event, fields);
}

export function logError(event, fields) {
  emit('error', event, fields);
}

function emit(level, event, fields) {
  const console = globalThis.console;
  if (!console) return;
  const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'debug';
  const detail = formatFields(fields);
  const line = `${PREFIX} ${event}${detail ? ` ${detail}` : ''}`;
  if (typeof console[method] === 'function') console[method](line);
  else if (typeof console.log === 'function') console.log(line);
}

export function formatFields(fields = {}) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (REDACTED_FIELD.test(name)) {
      parts.push(`${name}=<redacted>`);
      continue;
    }
    parts.push(`${name}=${formatValue(value)}`);
  }
  return parts.join(' ');
}

function formatValue(value) {
  if (typeof value === 'string') return JSON.stringify(value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}\u2026` : value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Error) return JSON.stringify(value.message);
  try {
    return formatValue(JSON.stringify(value));
  } catch {
    return '"<unserializable>"';
  }
}
