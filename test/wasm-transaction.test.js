import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { prepareCreateGame } from '../src/create-game.js';
import { createGenesisGameOutput, computeGenesisCovenantId } from '../src/genesis-transaction.js';
import { createWasmGenesisSafeJson, verifyWasmSignedSafeJson } from '../src/wasm-transaction.js';
import { deriveGameInstance } from '../src/covenant/even-odd.mjs';
import { playerLockSompi } from '../src/protocol.js';

const require = createRequire(import.meta.url);
const VENDOR_DIR = fileURLToPath(new URL('../vendor/kaspa-wasm32-sdk/v2.0.1/nodejs/kaspa/', import.meta.url));
const KASPA_JS = join(VENDOR_DIR, 'kaspa.js');
const KASPA_WASM = join(VENDOR_DIR, 'kaspa_bg.wasm');

const request = prepareCreateGame({
  network: 'testnet-10',
  creatorAddress: 'kaspatest:creator',
  creatorPublicKey: '07'.repeat(32),
  creatorCommitment: '09'.repeat(32),
  deadlineDaa: 500000000000n,
  side: 'even',
  stakeKas: 1,
  feeSompi: 1000n,
  gameFeePublicKey: '11'.repeat(32),
});

function fundingInput(amount = playerLockSompi(request.stakeSompi) + 400_000_000n) {
  return {
    transactionId: '11'.repeat(32),
    index: 2,
    sequence: '0',
    sigOpCount: 0,
    computeBudget: 0,
    signatureScript: '',
    amount,
    scriptPublicKey: '000051',
    blockDaaScore: 1n,
    isCoinbase: false,
  };
}

test('vendored WASM binary matches the pinned artifact checksum', () => {
  const pins = JSON.parse(readFileSync(new URL('../covenant/pins.json', import.meta.url), 'utf8'));
  const expected = pins.rustyKaspa.vendoredWasmFileSha256;
  assert.match(expected, /^[0-9a-f]{64}$/);
  const actual = createHash('sha256').update(readFileSync(KASPA_WASM)).digest('hex');
  assert.equal(actual, expected);
});

test('WASM package loads and exposes the construction primitives', () => {
  const wasm = require(KASPA_JS);
  assert.equal(typeof wasm.Transaction.deserializeFromSafeJSON, 'function');
  assert.equal(typeof wasm.GenesisCovenantGroup, 'function');
  assert.equal(typeof wasm.Transaction.prototype.populateGenesisCovenants, 'function');
  assert.equal(typeof wasm.Transaction.prototype.serializeToSafeJSON, 'function');
});

test('WASM-bound output zero matches exact stake, P2SH, and genesis covenant', () => {
  const prepared = createWasmGenesisSafeJson({ request, authorizingInput: 0, inputs: [fundingInput()] });
  const transaction = JSON.parse(prepared.txJson);
  const expected = createGenesisGameOutput({ request, authorizingInput: 0, authorizingOutpoint: transaction.inputs[0] });

  assert.equal(transaction.outputs[0].value, expected.value);
  assert.equal(transaction.outputs[0].scriptPublicKey, expected.scriptPublicKey);
  assert.equal(transaction.outputs[0].covenant.authorizingInput, 0);
  assert.equal(transaction.outputs[0].covenant.covenantId, expected.covenant.covenantId);
  assert.equal(prepared.covenantId, expected.covenant.covenantId);
});

test('WASM genesis covenant-id is the Rusty Kaspa v2.0.1 oracle', () => {
  const prepared = createWasmGenesisSafeJson({ request, authorizingInput: 0, inputs: [fundingInput()] });
  const transaction = JSON.parse(prepared.txJson);
  const oracle = computeGenesisCovenantId(
    transaction.inputs[0],
    [{ index: 0, output: { value: transaction.outputs[0].value, scriptPublicKey: transaction.outputs[0].scriptPublicKey } }],
  );
  assert.equal(prepared.covenantId, oracle);
});

test('WASM covenant address matches the pure-JS game instance oracle', () => {
  const prepared = createWasmGenesisSafeJson({ request, authorizingInput: 0, inputs: [fundingInput()] });
  const transaction = JSON.parse(prepared.txJson);
  const instance = deriveGameInstance({
    creatorPubkey: new Array(32).fill(7),
    creatorCommit: new Array(32).fill(9),
    stakeSompi: request.stakeSompi,
    deadlineDaa: request.deadlineDaa,
    creatorEven: true,
    gameWalletHash: request.gameWalletHash,
  }, { addressPrefix: 'kaspatest' });
  assert.equal(transaction.outputs[0].scriptPublicKey, '0000' + instance.p2shScript.toString('hex'));
});

test('WASM SafeJSON round-trips through deserializeFromSafeJSON', () => {
  const prepared = createWasmGenesisSafeJson({ request, authorizingInput: 0, inputs: [fundingInput()] });
  const raw = JSON.parse(prepared.txJson);
  const wasm = require(KASPA_JS);
  const round = JSON.parse(wasm.Transaction.deserializeFromSafeJSON(prepared.txJson).serializeToSafeJSON());
  assert.deepEqual(round.outputs, raw.outputs);
  assert.deepEqual(round.inputs.map((i) => i.utxo), raw.inputs.map((i) => i.utxo));
});

test('WASM verify allows only signature-script changes', () => {
  const prepared = createWasmGenesisSafeJson({ request, authorizingInput: 0, inputs: [fundingInput()] });
  const signed = JSON.parse(prepared.txJson);
  signed.id = 'fe'.repeat(32);
  signed.inputs[0].signatureScript = '01aa';
  const result = verifyWasmSignedSafeJson({ preparedTxJson: prepared.txJson, signedTxJson: JSON.stringify(signed), policy: prepared.policy });
  assert.equal(typeof result, 'string');
});

test('WASM verify rejects mutation of the game output or input funds', () => {
  const prepared = createWasmGenesisSafeJson({ request, authorizingInput: 0, inputs: [fundingInput()] });

  const lowered = JSON.parse(prepared.txJson);
  lowered.outputs[0].value = (playerLockSompi(request.stakeSompi) - 1n).toString();
  assert.throws(() => verifyWasmSignedSafeJson({ preparedTxJson: prepared.txJson, signedTxJson: JSON.stringify(lowered), policy: prepared.policy }), { code: 'SIGNED_TRANSACTION_MISMATCH' });

  const changedScript = JSON.parse(prepared.txJson);
  changedScript.outputs[0].scriptPublicKey = 'aa20' + 'ab'.repeat(32);
  assert.throws(() => verifyWasmSignedSafeJson({ preparedTxJson: prepared.txJson, signedTxJson: JSON.stringify(changedScript), policy: prepared.policy }), { code: 'SIGNED_TRANSACTION_MISMATCH' });
});

test('WASM requires fundable regarding authorizing input index', () => {
  assert.throws(
    () => createWasmGenesisSafeJson({ request, authorizingInput: 1, inputs: [fundingInput()] }),
    { code: 'INVALID_TRANSACTION' },
  );
  assert.throws(
    () => createWasmGenesisSafeJson({ request, authorizingInput: 0, inputs: [] }),
    { code: 'INVALID_TRANSACTION' },
  );
});
