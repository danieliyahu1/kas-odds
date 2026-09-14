import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { blake2b256 } from '../src/hashes/blake2b.mjs';
import { bech32Encode, bech32Decode } from '../src/hashes/bech32.mjs';
import { bytesToHex, hexToBytes } from '../src/hashes/hex.mjs';
import {
  EVEN_ODD_TEMPLATE,
  deriveGameInstance,
  verifyTemplateHash,
  parseCovenantAddress,
} from '../src/covenant/even-odd.mjs';

const FEE_PUBLIC_KEY = '11'.repeat(32);
const gameWalletHash = bytesToHex(blake2b256(hexToBytes(FEE_PUBLIC_KEY))).toLowerCase();

test('blake2b-256 single block matches published vector', () => {
  // abc -> published BLAKE2b-256 digest
  assert.equal(
    Buffer.from(blake2b256(new TextEncoder().encode('abc'))).toString('hex'),
    'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319'
  );
});

test('blake2b-256 multi-block matches the covenant-oracle digest', () => {
  // Cross-validated against the Rust covenant-oracle (blake2b_simd hash_length(32))
  // over the exact even/odd instance with creator_pk=0x07*32,
  // creator_commit=0x09*32, stake=100000000, deadline_daa=500000000000,
  // wallet_pk=0x11*32 (game_wallet_hash = blake2b(wallet_pk)).
  const creatorPubkey = new Array(32).fill(7);
  const creatorCommit = new Array(32).fill(9);
  const inst = deriveGameInstance({ creatorPubkey, creatorCommit, stakeSompi: 100000000n, deadlineDaa: 500000000000n, gameWalletHash });
   assert.equal(inst.redeemScript.length, 1672);
  assert.equal(
    Buffer.from(blake2b256(Uint8Array.from(inst.redeemScript))).toString('hex'),
     'be219a9430a05eb69d0eda680fcb6b296c09eb7d107aeb3c7efde77dab5252b4'
  );
});

test('bech32 encode matches kaspa-addresses golden vectors', () => {
  // Address::new(Testnet, PubKey, &[0u8;32])
  assert.equal(
    bech32Encode('kaspatest', 0, new Uint8Array(32).fill(0)),
    'kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya'
  );
  // Address::new(B, ScriptHash, b"abc")
  assert.equal(
    bech32Encode('b', 8, new TextEncoder().encode('abc')),
    'b:ppskycc8txxxn2w'
  );
  // Address::new(Testnet, PubKeyECDSA, &[0u8;33])
  assert.equal(
    bech32Encode('kaspatest', 1, new Uint8Array(33).fill(0)),
    'kaspatest:qyqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhe837j2d'
  );
});

test('bech32 decode round-trips and rejects a corrupt checksum', () => {
  const addr = 'kaspatest:qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrxplya';
  const d = bech32Decode(addr);
  assert.equal(d.prefix, 'kaspatest');
  assert.equal(d.version, 0);
  assert.equal(d.payload.length, 32);
  assert.equal(bech32Encode(d.prefix, d.version, d.payload), addr);
  assert.throws(() => bech32Decode(addr.slice(0, -2) + 'qq'));
});

test('pinned template hash verifies against the compiled artifact', () => {
  const v = verifyTemplateHash();
  assert.equal(v.computed, EVEN_ODD_TEMPLATE.templateHash);
   assert.equal(v.computed, 'f411b38af5e5b42b1588dd5e4f1282e21f66b82ff5f85b9212c8ede729d9953f');
  assert.equal(v.prefixLen, 1);
   assert.equal(v.suffixLen, 1419);
  assert.equal(v.state.length, 252);
});

test('reproducibility manifest matches covenant source and artifact bytes', () => {
  const pins = JSON.parse(readFileSync(new URL('../covenant/pins.json', import.meta.url), 'utf8'));
  assert.equal(sha256('../covenant/even_odd.sil'), pins.covenant.sourceSha256);
  assert.equal(sha256('../covenant/even_odd.template.artifact.json'), pins.covenant.artifactSha256);
  assert.equal(pins.covenant.templateHash, EVEN_ODD_TEMPLATE.templateHash);
  assert.equal(pins.rustyKaspa.wasmReleaseSha256, '7eaffac9cd920ef2fdf540c6e10f2a2b7761170ebc62ec57dfa0f71c64567a71');
  assert.equal(pins.rustyKaspa.status, 'pinned');
});

test('pinned SilverScript release matches the loaded artifact', () => {
  const pins = JSON.parse(readFileSync(new URL('../covenant/pins.json', import.meta.url), 'utf8'));
  assert.equal(pins.silverscript.release, 'v1.0.0');
  assert.equal(pins.silverscript.sourceCommit, '3ed973335b59269293564805cc2c58a14595ec03');
  assert.equal(pins.silverscript.compilerVersion, '0.1.0');
  assert.equal(EVEN_ODD_TEMPLATE.compilerVersion, pins.silverscript.compilerVersion);
});

test('per-game instance matches the covenant-oracle P2SH address', () => {
  const creatorPubkey = new Array(32).fill(7);
  const creatorCommit = new Array(32).fill(9);
  const inst = deriveGameInstance({ creatorPubkey, creatorCommit, stakeSompi: 100000000n, deadlineDaa: 500000000000n, gameWalletHash });
  // Governed by the Rust covenant-oracle: encode_runtime_state_script + script_parts
  // + Address::new(Testnet, ScriptHash, blake2b256(instance)).
   assert.equal(inst.address, 'kaspatest:pzlzrx55xzs9ad5apmdxsr7tdv5kcz0t05g846eu0m77wldt2fftg32s4jvjf');
  assert.equal(
    inst.p2shScript.toString('hex'),
     'aa20be219a9430a05eb69d0eda680fcb6b296c09eb7d107aeb3c7efde77dab5252b487'
  );
  assert.equal(inst.templateHash, EVEN_ODD_TEMPLATE.templateHash);
  assert.equal(inst.address.startsWith('kaspatest:'), true);
  assert.equal(parseCovenantAddress(inst.address).version, 8);
});

test('different game state produces a different covenant address', () => {
  const base = { creatorPubkey: new Array(32).fill(7), creatorCommit: new Array(32).fill(9), stakeSompi: 100000000n, deadlineDaa: 500000000000n, gameWalletHash };
  const a = deriveGameInstance(base);
  const b = deriveGameInstance({ ...base, creatorPubkey: new Array(32).fill(8) });
  assert.notEqual(a.address, b.address);
});

test('rejects invalid game state', () => {
  assert.throws(() => deriveGameInstance({ creatorPubkey: [1, 2, 3], creatorCommit: new Array(32).fill(9), stakeSompi: 100000000n, deadlineDaa: 500000000000n, gameWalletHash }));
  assert.throws(() => deriveGameInstance({ creatorPubkey: new Array(32).fill(7), creatorCommit: new Array(32).fill(9), stakeSompi: -1n, deadlineDaa: 500000000000n, gameWalletHash }));
  assert.throws(() => deriveGameInstance({ creatorPubkey: new Array(32).fill(7), creatorCommit: new Array(32).fill(9), stakeSompi: 99999999n, deadlineDaa: 500000000000n, gameWalletHash }), { code: 'INVALID_STATE' });
});

function sha256(relativePath) {
  return createHash('sha256').update(readFileSync(new URL(relativePath, import.meta.url))).digest('hex');
}
