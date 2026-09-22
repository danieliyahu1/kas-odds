import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_CODE_PATTERN, generateRoomCode, isRoomCode, normalizeRoomCode } from '../src/room-code.js';

test('a generated room code is six unambiguous characters', () => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const code = generateRoomCode();
    assert.equal(code.length, ROOM_CODE_LENGTH);
    assert.match(code, ROOM_CODE_PATTERN);
    for (const character of code) assert.ok(ROOM_CODE_ALPHABET.includes(character), `${character} is not in the alphabet`);
  }
});

test('the alphabet excludes glyphs that are easily misread', () => {
  for (const ambiguous of ['0', 'O', '1', 'I', 'L']) {
    assert.ok(!ROOM_CODE_ALPHABET.includes(ambiguous), `alphabet should not contain ${ambiguous}`);
  }
});

test('generation maps the accepted byte range deterministically', () => {
  // Rejection sampling discards the top bytes so the rest map evenly; every
  // accepted value must resolve to one stable character.
  const accepted = 256 - (256 % ROOM_CODE_ALPHABET.length);
  const seen = new Set();
  for (let value = 0; value < accepted; value += 1) {
    const code = generateRoomCode(() => Uint8Array.from({ length: ROOM_CODE_LENGTH }, () => value));
    assert.equal(code, ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length].repeat(ROOM_CODE_LENGTH));
    seen.add(code[0]);
  }
  assert.equal(seen.size, ROOM_CODE_ALPHABET.length);
});

test('a rejected byte is skipped rather than wrapped into a biased index', () => {
  const accepted = 256 - (256 % ROOM_CODE_ALPHABET.length);
  let call = 0;
  const source = () => Uint8Array.from({ length: ROOM_CODE_LENGTH }, () => (call++ === 0 ? accepted : 0));
  const code = generateRoomCode(source);
  assert.equal(code, ROOM_CODE_ALPHABET[0].repeat(ROOM_CODE_LENGTH));
});

test('normalization folds case and ignores spacing separators', () => {
  assert.equal(normalizeRoomCode('k7pq2m'), 'K7PQ2M');
  assert.equal(normalizeRoomCode(' K7PQ-2M '), 'K7PQ2M');
  assert.equal(normalizeRoomCode('K7PQ_2M'), 'K7PQ2M');
});

test('normalization rejects a code that is malformed rather than correcting it', () => {
  assert.equal(normalizeRoomCode('K7PQ2'), null);
  assert.equal(normalizeRoomCode('K7PQ2MO'), null);
  assert.equal(normalizeRoomCode('K7PQ2I'), null);
  assert.equal(normalizeRoomCode(''), null);
  assert.equal(normalizeRoomCode(null), null);
  assert.equal(normalizeRoomCode(123456), null);
  assert.equal(isRoomCode('K7PQ2M'), true);
  assert.equal(isRoomCode('K7PQ2'), false);
});
