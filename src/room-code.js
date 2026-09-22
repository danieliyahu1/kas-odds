// Short, human-typable handle for a private friend room.
//
// A room code lets a friend join a private game by typing a word instead of
// opening a URL, so an invite survives platforms that flag or ban links. The
// alphabet omits easily confused glyphs (0/O/1/I/L) and normalization folds
// case, so a code read aloud or retyped still resolves.
//
// The module is isomorphic: it uses the Web Crypto API (`crypto.getRandomValues`)
// that Node and browsers both provide, so the server and `public/lobby-controller.js`
// share one normalization rule. It carries no secret — a code is only a lookup
// alias for a live private room, never a key, commitment, or wallet identifier.

export const ROOM_CODE_LENGTH = 6;
// 31 characters: digits 2-9 and the letters minus I, L, and O, so nothing in a
// code can be misread as another character. 31 does not divide 256, so
// generation rejects the top byte range instead of accepting modulo skew.
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

// Byte values at or above this are discarded: 256 % 31 == 8, so rejecting 248-255
// makes every remaining value map to an alphabet index with equal probability.
const BYTE_LIMIT = 256 - (256 % ROOM_CODE_ALPHABET.length);

export function generateRoomCode(randomValues = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length))) {
  let code = '';
  while (code.length < ROOM_CODE_LENGTH) {
    const bytes = randomValues(ROOM_CODE_LENGTH);
    for (const byte of bytes) {
      if (code.length === ROOM_CODE_LENGTH) break;
      if (byte >= BYTE_LIMIT) continue;
      code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
    }
  }
  return code;
}

// Uppercase, drop spacing separators, then require exactly one code of valid
// characters. An ambiguous glyph or wrong length is rejected, never silently
// corrected, so a mistyped code fails clearly instead of reaching the wrong room.
export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toUpperCase().replace(/[\s_-]+/g, '');
  return ROOM_CODE_PATTERN.test(cleaned) ? cleaned : null;
}

export function isRoomCode(value) {
  return normalizeRoomCode(value) !== null;
}
