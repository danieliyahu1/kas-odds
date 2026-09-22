import test from 'node:test';
import assert from 'node:assert/strict';
import { BotWallet } from '../src/bot-wallet.js';
import { createRevealSecret, verifyRevealPreimage } from '../src/reveal.js';

const PRIVATE_KEY = '11'.repeat(32);

function sampleTx(publicKey, covenantSignatureScript = '51') {
  return JSON.stringify({
    id: '00'.repeat(32),
    version: 1,
    inputs: [
      { transactionId: 'aa'.repeat(32), index: 0, sequence: '0', sigOpCount: 0, computeBudget: 50, signatureScript: covenantSignatureScript, utxo: { amount: '200000000', scriptPublicKey: `000020${publicKey}ac`, blockDaaScore: '1', isCoinbase: false } },
      { transactionId: 'bb'.repeat(32), index: 1, sequence: '0', sigOpCount: 0, computeBudget: 50, signatureScript: '', utxo: { amount: '100000000', scriptPublicKey: `000020${publicKey}ac`, blockDaaScore: '1', isCoinbase: false } },
    ],
    outputs: [{ value: '200000000', scriptPublicKey: `000020${publicKey}ac`, covenant: null }],
    lockTime: '0',
    subnetworkId: '00'.repeat(20),
    gas: '0',
    payload: '',
  });
}

test('the bot wallet derives an x-only public key and a per-network address', () => {
  const testnet = new BotWallet({ privateKeyHex: PRIVATE_KEY, network: 'testnet-10' });
  const mainnet = new BotWallet({ privateKeyHex: PRIVATE_KEY, network: 'mainnet' });
  assert.match(testnet.publicKey, /^[0-9a-f]{64}$/);
  assert.match(testnet.address, /^kaspatest:/);
  assert.match(mainnet.address, /^kaspa:/);
  assert.equal(testnet.publicKey, mainnet.publicKey);
  assert.throws(() => new BotWallet({ privateKeyHex: 'nope', network: 'testnet-10' }), { code: 'INVALID_BOT_KEY' });
});

test('the bot signs only its own unsigned inputs and leaves the covenant invocation intact', () => {
  const wallet = new BotWallet({ privateKeyHex: PRIVATE_KEY, network: 'testnet-10' });
  const signed = JSON.parse(wallet.sign(sampleTx(wallet.publicKey)));
  assert.equal(signed.inputs[0].signatureScript, '51', 'the covenant entry script is never overwritten');
  assert.ok(signed.inputs[1].signatureScript.length > 0, 'the funding input is signed');
});

test('signing a transaction with no bot inputs fails cleanly', () => {
  const wallet = new BotWallet({ privateKeyHex: PRIVATE_KEY, network: 'testnet-10' });
  assert.throws(() => wallet.sign(sampleTx(wallet.publicKey, '51').replace('"signatureScript":""', '"signatureScript":"51"')), { code: 'SIGNING_FAILED' });
});

test('the bot reveal is random and verifies against its commitment', () => {
  const gameId = 'c'.repeat(64);
  const first = createRevealSecret({ gameId, player: 'kaspatest:bot', choice: 0 });
  const again = createRevealSecret({ gameId, player: 'kaspatest:bot', choice: 1 });
  assert.ok(first.choice === 0 || first.choice === 1);
  assert.equal(first.nonceHex.length, 64);
  assert.equal(verifyRevealPreimage({ commitment: first.commitment, choice: first.choice, nonceHex: first.nonceHex }), true);
  assert.notEqual(again.nonceHex, first.nonceHex, 'each join draws a fresh nonce');
});
