import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildKccEntrySignatureScript,
  prepareFallbackClaimTransaction,
  prepareOpenRefundTransaction,
  prepareRefundAllTransaction,
  prepareRevealTransaction,
  prepareTerminalTransaction,
  serializeTerminalTransaction,
  validateRevealTemplate,
  verifySignedTerminalTransaction,
} from '../src/terminal-transactions.js';
import { createRevealSecret } from '../src/reveal.js';

const game = {
  gameId: 'aa'.repeat(32),
  confirmationStatus: 'confirmed',
  stakeSompi: 100_000_000n,
  potSompi: 200_000_000n,
  joinedDaaScore: 1_000n,
  creatorAddress: 'creator',
  joinerAddress: 'joiner',
  participants: {
    creator: { scriptPublicKey: '000051' },
    joiner: { scriptPublicKey: '000052' },
  },
};
const creatorSecret = createRevealSecret({ gameId: game.gameId, player: 'creator', choice: 1, nonce: new Uint8Array(32).fill(7) });
const joinerSecret = createRevealSecret({ gameId: game.gameId, player: 'joiner', choice: 0, nonce: new Uint8Array(32).fill(8) });
const revealGame = {
  ...game,
  commitments: { creator: creatorSecret.commitment, joiner: joinerSecret.commitment },
  participants: {
    creator: { scriptPublicKey: '000051', commitment: creatorSecret.commitment },
    joiner: { scriptPublicKey: '000052', commitment: joinerSecret.commitment },
  },
};

const gameInput = {
  transactionId: '11'.repeat(32),
  index: 0,
  amount: 200_000_000n,
  scriptPublicKey: '0000aa20' + '00'.repeat(32) + '87',
  blockDaaScore: 1n,
};

const feeInput = {
  transactionId: '22'.repeat(32),
  index: 0,
  amount: 1_000_000n,
  scriptPublicKey: '000051',
};

const gameWalletPublicKey = '22'.repeat(32);
const gameFeeScriptPublicKey = '000053';

test('encodes KCC arguments and dispatch tag from the pinned artifact', () => {
  const script = buildKccEntrySignatureScript({
    entry: 'refund_all',
    args: [new Uint8Array(32), new Uint8Array(32)],
  });
  assert.match(script.toString('hex'), /0e2b436c$/);
});

test('prepares and serializes an authorized fallback claim transaction', () => {
  const prepared = prepareFallbackClaimTransaction({
    game: { ...game, firstReveal: { player: 'creator', confirmedDaaScore: 2_000n } },
    caller: 'creator',
    currentDaaScore: 5_000n,
    gameInput,
    recipientScriptPublicKey: '000051',
    feeInputs: [feeInput],
    feeSompi: 1_000n,
    change: { value: 999_000n, scriptPublicKey: '000051' },
    publicKey: new Uint8Array(32).fill(7),
    walletPublicKey: gameWalletPublicKey,
    feeScriptPublicKey: gameFeeScriptPublicKey,
  });
  const transaction = JSON.parse(serializeTerminalTransaction(prepared));
  assert.equal(transaction.inputs[0].sequence, '3000');
   assert.equal(transaction.outputs[0].value, '198400000');
  assert.equal(transaction.outputs.length, 1);
  assert.match(transaction.inputs[0].signatureScript, /e8bae487$/);
});

test('prepares a permissionless refund for both escrow holders', () => {
  const prepared = prepareRefundAllTransaction({
    gameInput,
    stakeSompi: game.stakeSompi,
    creatorPublicKey: '07'.repeat(32),
    joinerPublicKey: '08'.repeat(32),
  });
  const transaction = JSON.parse(serializeTerminalTransaction(prepared));
  assert.equal(transaction.inputs[0].sequence, '3000');
   assert.equal(transaction.outputs[0].value, '99200000');
   assert.equal(transaction.outputs[1].value, '99200000');
  assert.equal(transaction.inputs.length, 1);
  assert.match(transaction.inputs[0].signatureScript, /0e2b436c$/);
});

test('prepares an automatic refund for an unmatched creator', () => {
  const prepared = prepareOpenRefundTransaction({
    gameInput: { ...gameInput, amount: 100_000_000n },
    stakeSompi: 100_000_000n,
     settleFeeSompi: 1_600_000n,
    deadlineDaa: 5_000n,
    creatorPublicKey: '07'.repeat(32),
  });
  const transaction = JSON.parse(serializeTerminalTransaction(prepared));
  assert.equal(transaction.lockTime, '5000');
  assert.equal(transaction.inputs.length, 1);
  assert.equal(transaction.outputs.length, 1);
   assert.equal(transaction.outputs[0].value, '98400000');
  assert.match(transaction.inputs[0].signatureScript, /3a658a5b$/);
});

test('prepares first reveal as covenant continuation and second reveal as winner payout', () => {
  const first = prepareRevealTransaction({
    game: revealGame,
    caller: 'creator',
    currentDaaScore: 1_001n,
    secret: creatorSecret,
    gameInput,
    continuationScriptPublicKey: gameInput.scriptPublicKey,
    continuationCovenant: { authorizingInput: 0, covenantId: '33'.repeat(32) },
    feeSompi: 1_000n,
    feeInputs: [feeInput],
    change: { value: 999_000n, scriptPublicKey: '000051' },
    publicKey: new Uint8Array(32).fill(7),
    walletPublicKey: gameWalletPublicKey,
  });
  const firstTx = JSON.parse(serializeTerminalTransaction(first));
   assert.equal(firstTx.outputs[0].value, '200000000');
  assert.equal(firstTx.outputs[0].covenant.covenantId, '33'.repeat(32));
  assert.match(firstTx.inputs[0].signatureScript, /6b547798$/);
  assert.equal(validateRevealTemplate({ game: revealGame, caller: 'creator', currentDaaScore: 1_001n, secret: creatorSecret, transaction: firstTx }), firstTx);

  const secondGame = { ...revealGame, firstReveal: { player: 'creator', confirmedDaaScore: 2_000n }, reveals: { creator: true }, creatorChoice: 1, creatorEven: true };
  const second = prepareRevealTransaction({
    game: secondGame,
    caller: 'joiner',
    currentDaaScore: 2_010n,
    secret: joinerSecret,
    gameInput,
    recipientScriptPublicKey: '000052',
    feeSompi: 1_000n,
    feeInputs: [feeInput],
    change: { value: 999_000n, scriptPublicKey: '000052' },
    publicKey: new Uint8Array(32).fill(8),
    walletPublicKey: gameWalletPublicKey,
    feeScriptPublicKey: gameFeeScriptPublicKey,
  });
  const secondTx = JSON.parse(serializeTerminalTransaction(second));
   assert.equal(secondTx.outputs[0].value, '200000000');
   assert.equal(secondTx.outputs[0].scriptPublicKey, '000052');
   assert.equal(secondTx.outputs[1].value, '999000');
  assert.equal(validateRevealTemplate({ game: secondGame, caller: 'joiner', currentDaaScore: 2_010n, secret: joinerSecret, transaction: secondTx }), secondTx);
});

test('prepares an unmatched creator refund with lock time and ordinary payout', () => {
  const prepared = prepareTerminalTransaction({
    action: 'refund',
    gameInput: { ...gameInput, amount: 100_000_000n },
    lockTime: 5_000n,
    args: [new Uint8Array(32).fill(7)],
    payoutValue: 100_000_000n,
    recipientScriptPublicKey: '000051',
    feeInputs: [feeInput],
    feeSompi: 1_000n,
    change: { value: 999_000n, scriptPublicKey: '000051' },
  });
  const transaction = JSON.parse(serializeTerminalTransaction(prepared));
  assert.equal(transaction.lockTime, '5000');
  assert.equal(transaction.outputs[0].covenant, null);
  assert.equal(transaction.outputs[0].value, '100000000');
});

test('refuses terminal transaction preparation when chain state is not eligible', () => {
  assert.throws(() => prepareFallbackClaimTransaction({
    game,
    caller: 'creator',
    currentDaaScore: 4_000n,
    gameInput,
    recipientScriptPublicKey: '000051',
    publicKey: new Uint8Array(32).fill(7),
  }), { code: 'ACTION_UNAVAILABLE' });
});

test('automatic settlement requires no wallet signing', () => {
  const prepared = prepareRefundAllTransaction({ gameInput, stakeSompi: game.stakeSompi, creatorPublicKey: '07'.repeat(32), joinerPublicKey: '08'.repeat(32) });
  const transaction = JSON.parse(serializeTerminalTransaction(prepared));
  assert.equal(transaction.inputs.length, 1);
  assert.match(transaction.inputs[0].signatureScript, /0e2b436c$/);
});
