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
import { parseTemplateArtifact } from '../src/covenant/even-odd-core.mjs';

const FEE_PUBLIC_KEY = '11'.repeat(32);
const gameWalletHash = bytesToHex(blake2b256(hexToBytes(FEE_PUBLIC_KEY))).toLowerCase();
const deriveOnTestnet = (game, opts = {}) => deriveGameInstance(game, { ...opts, addressPrefix: 'kaspatest' });

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
  const inst = deriveOnTestnet({ creatorPubkey, creatorCommit, stakeSompi: 100000000n, deadlineDaa: 500000000000n, gameWalletHash });
  assert.equal(inst.redeemScript.length, 1769);
  assert.equal(
    Buffer.from(blake2b256(Uint8Array.from(inst.redeemScript))).toString('hex'),
    '53d380d09b45ad4b13f92ff975b2c42c45618562417b7b8a0e081b3af401455f'
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
  assert.equal(v.computed, 'ade3453c61ac5858b344b22ccf373e7e44ab18c14506f49b69e29f763057e27a');
  assert.equal(v.prefixLen, 1);
  assert.equal(v.suffixLen, 1507);
  assert.equal(v.state.length, 261);
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
  const inst = deriveOnTestnet({ creatorPubkey, creatorCommit, stakeSompi: 100000000n, deadlineDaa: 500000000000n, gameWalletHash });
  // Governed by the Rust covenant-oracle: encode_runtime_state_script + script_parts
  // + Address::new(Testnet, ScriptHash, blake2b256(instance)).
  assert.equal(inst.address, 'kaspatest:ppfa8qxsndz66jcnlyhljadjcsky2cv9vfqhk7u2pcypkwh5q9z47yvzemczr');
  assert.equal(
    inst.p2shScript.toString('hex'),
    'aa2053d380d09b45ad4b13f92ff975b2c42c45618562417b7b8a0e081b3af401455f87'
  );
  assert.equal(inst.templateHash, EVEN_ODD_TEMPLATE.templateHash);
  assert.equal(inst.address.startsWith('kaspatest:'), true);
  assert.equal(parseCovenantAddress(inst.address).version, 8);
});

test('derives the same mainnet script with a kaspa-prefixed address', () => {
  const game = { creatorPubkey: new Array(32).fill(7), creatorCommit: new Array(32).fill(9), stakeSompi: 100000000n, deadlineDaa: 500000000000n, gameWalletHash };
  const testnet = deriveOnTestnet(game);
  const mainnet = deriveGameInstance(game, { addressPrefix: 'kaspa' });
  assert.equal(mainnet.address.startsWith('kaspa:'), true);
  assert.notEqual(mainnet.address, testnet.address);
  assert.equal(mainnet.p2shScript.toString('hex'), testnet.p2shScript.toString('hex'));
  assert.equal(mainnet.templateHash, testnet.templateHash);
});

test('requires an address prefix to derive a covenant instance', () => {
  const game = { creatorPubkey: new Array(32).fill(7), creatorCommit: new Array(32).fill(9), stakeSompi: 100000000n, deadlineDaa: 500000000000n, gameWalletHash };
  assert.throws(() => deriveGameInstance(game), { code: 'INVALID_STATE' });
});

test('different game state produces a different covenant address', () => {
  const base = { creatorPubkey: new Array(32).fill(7), creatorCommit: new Array(32).fill(9), stakeSompi: 100000000n, deadlineDaa: 500000000000n, gameWalletHash };
  const a = deriveOnTestnet(base);
  const b = deriveOnTestnet({ ...base, creatorPubkey: new Array(32).fill(8) });
  assert.notEqual(a.address, b.address);
});

test('rejects invalid game state', () => {
  assert.throws(() => deriveOnTestnet({ creatorPubkey: [1, 2, 3], creatorCommit: new Array(32).fill(9), stakeSompi: 100000000n, deadlineDaa: 500000000000n, gameWalletHash }));
  assert.throws(() => deriveOnTestnet({ creatorPubkey: new Array(32).fill(7), creatorCommit: new Array(32).fill(9), stakeSompi: -1n, deadlineDaa: 500000000000n, gameWalletHash }));
  assert.throws(() => deriveOnTestnet({ creatorPubkey: new Array(32).fill(7), creatorCommit: new Array(32).fill(9), stakeSompi: 99999999n, deadlineDaa: 500000000000n, gameWalletHash }), { code: 'INVALID_STATE' });
});

test('rejects artifact ABI drift early and explicitly', () => {
  const artifact = JSON.parse(readFileSync(new URL('../covenant/even_odd.template.artifact.json', import.meta.url), 'utf8'));
  const clone = () => structuredClone(artifact);
  const driftState = clone();
  driftState.contracts.EvenOdd.runtime_state.fields[0].name = 'renamed_hash';
  assert.throws(() => parseTemplateArtifact(driftState), { code: 'ARTIFACT_MISMATCH' });
  const driftEntry = clone();
  driftEntry.contracts.EvenOdd.entries.join.params[0].name = 'renamed_pk';
  assert.throws(() => parseTemplateArtifact(driftEntry), { code: 'ARTIFACT_MISMATCH' });
  const driftCompiler = clone();
  driftCompiler.compiler_version = '0.2.0';
  assert.throws(() => parseTemplateArtifact(driftCompiler), { code: 'ARTIFACT_MISMATCH' });
  const driftSchema = clone();
  driftSchema.schema_version = 2;
  assert.throws(() => parseTemplateArtifact(driftSchema), { code: 'INVALID_ARTIFACT' });
});

test('rejects stale status and creator-side vocabulary', () => {
  const base = { creatorPubkey: new Array(32).fill(7), creatorCommit: new Array(32).fill(9), stakeSompi: 100000000n, deadlineDaa: 500000000000n, gameWalletHash };
  assert.throws(() => deriveOnTestnet({ ...base, status: 3 }), { code: 'INVALID_STATE' });
  assert.throws(() => deriveOnTestnet({ ...base, creatorEven: 2 }), { code: 'INVALID_STATE' });
  assert.throws(() => deriveOnTestnet({ ...base, creatorChoice: 2 }), { code: 'INVALID_STATE' });
  assert.throws(() => deriveOnTestnet({ ...base, settleFee: 1n }), { code: 'INVALID_STATE' });
  assert.throws(() => deriveOnTestnet({ ...base, settleFee: -2n }), { code: 'INVALID_STATE' });
  assert.throws(() => deriveOnTestnet({ ...base, settleFee: 3_200_000 }), { code: 'INVALID_STATE' });
});

function sha256(relativePath) {
  return createHash('sha256').update(readFileSync(new URL(relativePath, import.meta.url))).digest('hex');
}
