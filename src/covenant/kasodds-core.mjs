// Pure (isomorphic) KasOdds covenant derivation.
//
// This module has no Node-specific dependencies (no `fs`, `path`, `url`,
// `Buffer`, or `require`) so it runs byte-for-byte identically in the browser
// and in Node. The pinned template artifact is passed in explicitly via
// `parseTemplateArtifact`, keeping the artifact-loading concern in the caller.
//
// The Node entry point `kasodds.mjs` loads the artifact from disk and re-exports
// these functions with a `Buffer`-backed `deriveGameInstance` for backward
// compatibility; the browser imports this core module directly.
import { blake2b256 } from '../hashes/blake2b.mjs';
import { blake3 } from '../hashes/blake3.mjs';
import { bech32Encode, bech32Decode } from '../hashes/bech32.mjs';
import { hexToBytes, bytesToHex } from '../hashes/hex.mjs';
import { AUTOMATION_FEE_SOMPI, MIN_STAKE_SOMPI, ProtocolError } from '../protocol.js';

export { hexToBytes, bytesToHex };

function h2b(hex) {
  return hexToBytes(hex);
}

// Pinned KasOdds covenant template, parsed from the canonical compiled
// artifact. See covenant/kasodds.sil and covenant/kasodds.template.artifact.json.
export function parseTemplateArtifact(json) {
  if (!json || typeof json !== 'object' || json.schema_version !== 1) {
    throw new ProtocolError('INVALID_ARTIFACT', `unsupported artifact schema_version ${json?.schema_version}`);
  }
  if (json.compiler_version !== '0.1.0') {
    throw new ProtocolError('ARTIFACT_MISMATCH', `silverc compiler pinned to 0.1.0, artifact built with ${json.compiler_version}`);
  }
  const contract = json.contracts.KasOdds;
  if (!contract) throw new ProtocolError('INVALID_ARTIFACT', 'artifact has no KasOdds contract');
  const expectedState = [
    ['creator_hash', 'fixed_bytes', 32], ['joiner_hash', 'fixed_bytes', 32],
    ['creator_commit', 'fixed_bytes', 32], ['joiner_commit', 'fixed_bytes', 32],
    ['stake', 'int'], ['deadline_daa', 'int'], ['creator_even', 'int'],
    ['creator_choice', 'int'], ['joiner_choice', 'int'],
    ['first_revealer_hash', 'fixed_bytes', 32], ['game_wallet_hash', 'fixed_bytes', 32],
    ['status', 'int'], ['settle_fee', 'int'],
  ];
  const actualState = contract.runtime_state?.fields ?? [];
  if (actualState.length !== expectedState.length || actualState.some((field, index) => {
    const [name, kind, len] = expectedState[index];
    return field.name !== name || field.type?.kind !== kind || (len !== undefined && field.type.len !== len);
  })) {
    throw new ProtocolError('ARTIFACT_MISMATCH', 'KasOdds runtime state ABI does not match the pinned contract');
  }
  const expectedEntries = {
    refund: [['creator_pk', 'pubkey']],
    refund_open: [['creator_pk', 'pubkey']],
    refund_all: [['creator_pk', 'pubkey'], ['joiner_pk', 'pubkey']],
    fallback_claim: [['player_pk', 'pubkey'], ['wallet_pk', 'pubkey']],
    join: [['joiner_pk', 'pubkey'], ['new_joiner_commit', 'fixed_bytes', 32]],
    reveal: [['player_pk', 'pubkey'], ['choice', 'int'], ['nonce', 'fixed_bytes', 32], ['payout_pk', 'pubkey'], ['wallet_pk', 'pubkey']],
  };
  for (const [name, expectedParams] of Object.entries(expectedEntries)) {
    const entry = contract.entries?.[name];
    const actualParams = entry?.params ?? [];
    if (!entry || actualParams.length !== expectedParams.length || actualParams.some((param, index) => {
      const [paramName, kind, len] = expectedParams[index];
      return param.name !== paramName || param.type?.kind !== kind || (len !== undefined && param.type.len !== len);
    })) {
      throw new ProtocolError('ARTIFACT_MISMATCH', `KasOdds entry ABI does not match the pinned ${name} contract`);
    }
  }
  const compiled = contract.compiled;
  const templateHash = bytesToHex(Uint8Array.from(compiled.template_hash)).toLowerCase();
  const stateSpan = { offset: compiled.state_span.offset, len: compiled.state_span.len };
  return Object.freeze({
    schemaVersion: String(json.schema_version),
    compilerVersion: json.compiler_version,
    sourcePath: contract.source_path,
    templateHash,
    stateSpan,
    bytecodeHex: bytesToHex(Uint8Array.from(compiled.bytecode)),
    dispatchTags: Object.freeze({
      refund: contract.entries.refund.dispatch_tag,
      refund_open: contract.entries.refund_open.dispatch_tag,
      refund_all: contract.entries.refund_all.dispatch_tag,
      fallback_claim: contract.entries.fallback_claim.dispatch_tag,
      reveal: contract.entries.reveal.dispatch_tag,
      join: contract.entries.join.dispatch_tag,
    }),
    entryAbi: Object.freeze(Object.fromEntries(Object.entries(contract.entries).map(([name, entry]) => [name, entry.params]))),
    stateFieldOrder: contract.runtime_state.fields.map((f) => f.name),
  });
}

function encodeI64Fixed(value) {
  value = typeof value === 'bigint' ? value : BigInt(value);
  if (value < -(2n ** 63n - 1n) || value > 2n ** 63n - 1n) {
    throw new ProtocolError('INVALID_STATE', 'Covenant integer is outside the signed 64-bit range');
  }
  const out = new Uint8Array(8);
  let positive = value < 0n ? -value : value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(positive & 0xffn);
    positive >>= 8n;
  }
  if (value < 0n) out[7] |= 0x80;
  return out;
}

function encodeI64Length(value) {
  // serialize_i64(value, Some(8)) for positive lengths used by the template hash.
  return encodeI64Fixed(value);
}

function pushOpcodeLen(len) {
  if (len < 0x4c) return Uint8Array.of(len);
  if (len <= 0xff) return Uint8Array.of(0x4c, len);
  if (len <= 0xffff) return Uint8Array.of(0x4d, len & 0xff, (len >> 8) & 0xff);
  return Uint8Array.of(0x4e, len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff);
}

function pushData(data) {
  return new Uint8Array([...pushOpcodeLen(data.length), ...data]);
}

const ZERO32 = new Uint8Array(32);

function templateHash(prefix, suffix) {
  const pl = encodeI64Length(prefix.length);
  const sl = encodeI64Length(suffix.length);
  const concat = new Uint8Array(pl.length + prefix.length + sl.length + suffix.length);
  let o = 0;
  concat.set(pl, o); o += pl.length;
  concat.set(prefix, o); o += prefix.length;
  concat.set(sl, o); o += sl.length;
  concat.set(suffix, o);
  return bytesToHex(blake3(concat));
}

// Verify the pinned template by recomputing its hash from prefix/suffix split.
export function verifyTemplateHash(template) {
  const bc = h2b(template.bytecodeHex);
  const stateSpan = template.stateSpan;
  const prefix = bc.slice(0, stateSpan.offset);
  const state = bc.slice(stateSpan.offset, stateSpan.offset + stateSpan.len);
  const suffix = bc.slice(stateSpan.offset + stateSpan.len);
  const computed = templateHash(prefix, suffix);
  if (computed.toLowerCase() !== template.templateHash.toLowerCase()) {
    throw new ProtocolError('ARTIFACT_MISMATCH', `template hash mismatch: computed ${computed}, pinned ${template.templateHash}`);
  }
  return { prefix, state, suffix, computed, prefixLen: prefix.length, suffixLen: suffix.length };
}

function buildStateScript(game) {
  // state field order/enabling per the pinned runtime_state.
  const creatorPubkey = normalizeBytes(game.creatorPubkey, 32, 'creatorPubkey');
  const creatorCommit = normalizeBytes(game.creatorCommit, 32, 'creatorCommit');
  const joinerPubkey = game.joinerPubkey === undefined ? null : normalizeBytes(game.joinerPubkey, 32, 'joinerPubkey');
  const joinerCommit = game.joinerCommit === undefined ? ZERO32 : normalizeBytes(game.joinerCommit, 32, 'joinerCommit');
  if (typeof game.stakeSompi !== 'bigint' || game.stakeSompi < MIN_STAKE_SOMPI) {
    throw new ProtocolError('INVALID_STATE', 'stakeSompi must be at least 1 KAS');
  }
  if (typeof game.deadlineDaa !== 'bigint' || game.deadlineDaa <= 0n) {
    throw new ProtocolError('INVALID_STATE', 'deadlineDaa must be a positive bigint');
  }
  const creatorHash = blake2b256(creatorPubkey);
  const status = BigInt(game.status ?? 0);
  const creatorChoice = BigInt(game.creatorChoice ?? 0);
  const joinerChoice = BigInt(game.joinerChoice ?? 0);
  if (game.creatorEven !== undefined && game.creatorEven !== true && game.creatorEven !== false && game.creatorEven !== 0 && game.creatorEven !== 1 && game.creatorEven !== 0n && game.creatorEven !== 1n) {
    throw new ProtocolError('INVALID_STATE', 'creatorEven must be 0 or 1');
  }
  const creatorEven = game.creatorEven ? 1n : 0n;
  const settleFee = game.settleFee ?? AUTOMATION_FEE_SOMPI;
  if (![0n, 1n, 2n].includes(status) || ![0n, 1n].includes(creatorChoice) || ![0n, 1n].includes(joinerChoice)) {
    throw new ProtocolError('INVALID_STATE', 'status and choices must use the current covenant vocabulary');
  }
  if (typeof settleFee !== 'bigint' || settleFee <= 0n || settleFee % 2n !== 0n) {
    throw new ProtocolError('INVALID_STATE', 'settleFee must be a positive even bigint');
  }
  const firstRevealerHash = game.firstRevealerHash === undefined ? ZERO32 : normalizeBytes(game.firstRevealerHash, 32, 'firstRevealerHash');
  const gameWalletHash = game.gameWalletHash === undefined ? ZERO32 : normalizeBytes(game.gameWalletHash, 32, 'gameWalletHash');
  const parts = [
    pushData(creatorHash),      // creator_hash
    pushData(joinerPubkey ? blake2b256(joinerPubkey) : ZERO32),
    pushData(creatorCommit),    // creator_commit
    pushData(joinerCommit),
pushData(encodeI64Fixed(game.stakeSompi)),           // stake
    pushData(encodeI64Fixed(game.deadlineDaa)),          // deadline_daa
    pushData(encodeI64Fixed(creatorEven)),               // creator_even
    pushData(encodeI64Fixed(creatorChoice)),
    pushData(encodeI64Fixed(joinerChoice)),
    pushData(firstRevealerHash),
    pushData(gameWalletHash),                             // game_wallet_hash
    pushData(encodeI64Fixed(status)),
    pushData(encodeI64Fixed(settleFee)),                  // settle_fee
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const script = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { script.set(p, o); o += p.length; }
  return script;
}

function normalizeBytes(value, length, name) {
  let bytes;
  if (typeof value === 'string' && /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0) {
    bytes = hexToBytes(value);
  } else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    bytes = Uint8Array.from(value);
  } else {
    throw new ProtocolError('INVALID_STATE', `${name} must be ${length} bytes`);
  }
  if (bytes.length !== length) {
    throw new ProtocolError('INVALID_STATE', `${name} must be ${length} bytes`);
  }
  return bytes;
}

const SCRIPT_P2SH_OP = 0xaa; // OP_BLAKE2B (256) — Kaspa P2SH-256 marker; 0x20 = push 32.
const SCRIPT_OP_EQUAL = 0x87; // OP_EQUAL — closes the standard Kaspa P2SH script (aa 20 <hash> 87).

export function deriveGameInstance(game, { template, skipTemplateCheck = false, addressPrefix } = {}) {
  if (typeof addressPrefix !== 'string' || addressPrefix.length === 0) {
    throw new ProtocolError('INVALID_STATE', 'addressPrefix is required to derive a covenant address');
  }
  if (!template) throw new ProtocolError('INVALID_ARTIFACT', 'A covenant template is required to derive a game instance');
  const bytecode = h2b(template.bytecodeHex);
  const stateSpan = template.stateSpan;
  const prefix = bytecode.slice(0, stateSpan.offset);
  const suffix = bytecode.slice(stateSpan.offset + stateSpan.len);
  const stateScript = buildStateScript(game);
  const instance = new Uint8Array(prefix.length + stateScript.length + suffix.length);
  instance.set(prefix, 0);
  instance.set(stateScript, prefix.length);
  instance.set(suffix, prefix.length + stateScript.length);

  if (!skipTemplateCheck) {
    const computed = templateHash(prefix, suffix);
    if (computed.toLowerCase() !== template.templateHash.toLowerCase()) {
      throw new ProtocolError('ARTIFACT_MISMATCH', `template hash mismatch: ${computed}`);
    }
  }

  const redeemScript = instance;
  // Standard Kaspa P2SH-256 output script: OP_BLAKE2B PUSH32 <blake2b-256 hash> OP_EQUAL
  // (aa 20 <hash> 87). A bare aa20<hash> without the trailing OP_EQUAL is not a
  // standard script form and the node rejects it (forge reference / Kticket convention).
  const scriptPubKey = new Uint8Array([SCRIPT_P2SH_OP, 0x20, ...blake2b256(redeemScript), SCRIPT_OP_EQUAL]);
  const address = bech32Encode(addressPrefix, 8, blake2b256(redeemScript));
  return Object.freeze({
    templateHash: template.templateHash,
    redeemScript,
    p2shScript: scriptPubKey,
    address,
  });
}

export function parseCovenantAddress(address) {
  const { prefix, version, payload } = bech32Decode(address);
  return { prefix, version, payload };
}
