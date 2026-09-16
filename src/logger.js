// Dependency-free leveled logger for operational debugging.
//
// Output is identity-free by default: field names that could carry wallet
// addresses, transaction ids, nonces, keys, signatures, or request bodies are
// redacted before they reach the stream. Callers pass explicit scalar fields;
// request bodies and raw URLs are never logged.
//
// Set LOG_WALLET_ADDRESSES=1 for a debug session to reveal wallet addresses
// only. Nonces, keys, signatures, secrets, and bodies stay redacted in every
// mode, so commitments and reveal preimages are never written to the stream.
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const SECRET_FIELD = /(nonce|key|signature|private|secret|txjson|preparedhash|commitment|body|ip)/i;
const ADDRESS_FIELD = /address/i;
const MESSAGE_FIELD = /message/i;
const MAX_VALUE_LENGTH = 200;
const MAX_NODE_MESSAGE_LENGTH = 2000;

export function createLogger({
  level = process.env.LOG_LEVEL ?? 'info',
  format = process.env.LOG_FORMAT ?? 'text',
  stream = process.stderr,
  now = () => new Date(),
  redactAddresses = process.env.LOG_WALLET_ADDRESSES !== '1',
} = {}) {
  const normalizedLevel = String(level).toLowerCase();
  const threshold = LEVELS[normalizedLevel] ?? LEVELS.info;
  const normalizedFormat = format === 'json' ? 'json' : 'text';

  function emit(name, event, fields = {}) {
    if ((LEVELS[name] ?? LEVELS.info) < threshold) return;
    const timestamp = now().toISOString();
    const safe = sanitizeFields(fields, { redactAddresses });
    const line = normalizedFormat === 'json'
      ? JSON.stringify({ time: timestamp, level: name, event, ...safe })
      : renderText(timestamp, name, event, safe);
    stream.write(`${line}\n`);
  }

  return {
    level: normalizedLevel,
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

export const logger = createLogger();

export function sanitizeFields(fields = {}, { redactAddresses = true } = {}) {
  const safe = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (SECRET_FIELD.test(name) || (redactAddresses && ADDRESS_FIELD.test(name))) {
      safe[name] = '<redacted>';
      continue;
    }
    safe[name] = sanitizeValue(value, name);
  }
  return safe;
}

function sanitizeValue(value, fieldName) {
  if (typeof value === 'string') {
    const sanitized = fieldName === 'nodeMessage' || MESSAGE_FIELD.test(fieldName)
      ? value.replace(/\bkaspa[a-z]*:[a-z0-9]+/gi, '<address>')
        .replace(/\b[0-9a-f]{64}\b/gi, '<txid>')
        .replace(/\b[0-9a-f]{65,}\b/gi, '<hex>')
      : value;
    const maxLength = fieldName === 'nodeMessage' ? MAX_NODE_MESSAGE_LENGTH : MAX_VALUE_LENGTH;
    return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength)}\u2026` : sanitized;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;
  if (value instanceof Error) return value.message;
  try {
    return sanitizeValue(JSON.stringify(value), fieldName);
  } catch {
    return '<unserializable>';
  }
}

function renderText(timestamp, level, event, fields) {
  const parts = [timestamp, level.toUpperCase(), event];
  for (const name of Object.keys(fields).sort()) {
    const value = fields[name];
    if (value === '<redacted>') {
      parts.push(`${name}=<redacted>`);
      continue;
    }
    parts.push(`${name}=${typeof value === 'string' ? JSON.stringify(value) : String(value)}`);
  }
  return parts.join(' ');
}
