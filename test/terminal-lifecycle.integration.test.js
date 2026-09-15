import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAndConfirmTerminalAction,
  MemoryTerminalStore,
} from '../src/terminal-lifecycle.js';
import { createRevealSecret } from '../src/reveal.js';
import { prepareRevealTransaction, serializeTerminalTransaction } from '../src/terminal-transactions.js';

const creatorSecret = createRevealSecret({ gameId: 'aa'.repeat(32), player: 'creator', choice: 1, nonce: new Uint8Array(32).fill(7) });
const joinerSecret = createRevealSecret({ gameId: 'aa'.repeat(32), player: 'joiner', choice: 0, nonce: new Uint8Array(32).fill(8) });

const game = {
  gameId: 'aa'.repeat(32),
  network: 'testnet-10',
  confirmationStatus: 'confirmed',
  stakeSompi: 100_000_000n,
  potSompi: 200_000_000n,
  joinedDaaScore: 1_000n,
  creatorAddress: 'creator',
  joinerAddress: 'joiner',
  participants: { creator: { scriptPublicKey: '000051', commitment: creatorSecret.commitment }, joiner: { scriptPublicKey: '000052', commitment: joinerSecret.commitment } },
  commitments: { creator: creatorSecret.commitment, joiner: joinerSecret.commitment },
};

const request = {
  gameId: 'aa'.repeat(32),
  network: 'testnet-10',
  caller: 'creator',
  currentDaaScore: 4_000n,
  recipientScriptPublicKey: '000051',
  gameInput: { transactionId: '11'.repeat(32), index: 0, amount: 200_000_000n, scriptPublicKey: '0000aa20' + '00'.repeat(32) + '87', blockDaaScore: 1n },
  feeInputs: [{ transactionId: '22'.repeat(32), index: 0, amount: 1_000_000n, scriptPublicKey: '000051' }],
  feeSompi: 1_000n,
  continuationScriptPublicKey: '0000aa20' + '11'.repeat(32) + '87',
  continuationCovenant: { authorizingInput: 0, covenantId: '33'.repeat(32) },
  change: { value: 999_000n, scriptPublicKey: '000051' },
  publicKey: new Uint8Array(32).fill(7),
};

test('runs a normal second reveal through mocked wallet and chain settlement', async () => {
  const revealGame = { ...game, firstReveal: { player: 'creator', confirmedDaaScore: 2_000n }, reveals: { creator: true }, creatorChoice: 1, creatorEven: false };
  const revealRequest = {
    ...request,
    caller: 'joiner',
    currentDaaScore: 2_010n,
    secret: joinerSecret,
    recipientScriptPublicKey: '000051',
    publicKey: new Uint8Array(32).fill(8),
    payoutPublicKey: new Uint8Array(32).fill(7),
    walletPublicKey: '22'.repeat(32),
    feeScriptPublicKey: '000053',
    change: { value: 999_000n, scriptPublicKey: '000052' },
  };
  const base = prepareRevealTransaction({ ...revealRequest, game: revealGame });
  const chain = {
    readGameState: async () => revealGame,
    prepareTerminalAction: async () => ({ txJson: serializeTerminalTransaction(base), preparedHash: 'ef'.repeat(32) }),
    submitTerminal: async ({ action, signedTxJson }) => { assert.equal(action, 'reveal'); assert.match(signedTxJson, /01bb/); return 'ee'.repeat(32); },
    confirmTerminal: async () => ({ status: 'confirmed', acceptingDaaScore: 20n, confirmedDaaScore: 21n }),
  };
  const result = await createAndConfirmTerminalAction({
    action: 'reveal',
    request: revealRequest,
    chain,
    wallet: { sign: async ({ txJson, action }) => { assert.equal(action, 'reveal'); const tx = JSON.parse(txJson); tx.inputs[1].signatureScript = '01bb'; return JSON.stringify(tx); } },
    store: new MemoryTerminalStore(),
  });
  assert.deepEqual(result, { status: 'confirmed', transactionId: 'ee'.repeat(32), message: 'Reveal confirmed.' });
});
test('fails closed when the chain state is unknown or conflicting', async () => {
  const chain = { readGameState: async () => ({ ...game, confirmationStatus: 'pending' }) };
  await assert.rejects(() => createAndConfirmTerminalAction({ action: 'refund_all', request, chain, wallet: { sign: async () => '' }, store: new MemoryTerminalStore() }), { code: 'CHAIN_UNAVAILABLE' });
});
