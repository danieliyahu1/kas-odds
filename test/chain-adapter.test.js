import test from 'node:test';
import assert from 'node:assert/strict';
import { KaspaChainAdapter } from '../src/chain-adapter.js';

test('requires an RPC client', () => {
  assert.throws(() => new KaspaChainAdapter({}), { code: 'RPC_UNAVAILABLE' });
});

test('prepareCreation rejects a request without a creator address', async () => {
  const adapter = new KaspaChainAdapter({ rpc: {}, covenantAddress: 'x', scriptPublicKey: 'y' });
  await assert.rejects(adapter.prepareCreation({ covenantScriptPublicKey: '00'.repeat(34) }), { code: 'INVALID_TRANSACTION' });
});

test('prepareCreation rejects a request without a covenant script', async () => {
  const adapter = new KaspaChainAdapter({ rpc: {}, covenantAddress: 'x', scriptPublicKey: 'y' });
  await assert.rejects(adapter.prepareCreation({ creatorAddress: 'kaspatest:a' }), { code: 'INVALID_TRANSACTION' });
});

test('prepareCreation surfaces an empty wallet as no ordinary UTXOs', async () => {
  const rpc = {
    getUtxosByAddresses: async () => ({ entries: [] }),
    getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 1 }] } }),
  };
  const adapter = new KaspaChainAdapter({ rpc, covenantAddress: 'x', scriptPublicKey: 'y' });
  await assert.rejects(
    adapter.prepareCreation({ creatorAddress: 'kaspatest:a', covenantScriptPublicKey: '00'.repeat(34), stakeSompi: 100_000_000n, feeSompi: 0n, network: 'testnet-10' }),
    { code: 'NO_UTXOS' },
  );
});

test('gateway exposes validated DAA, UTXO, fee, and submission capabilities', async () => {
  const rpc = {
    getBlockDagInfo: async () => ({ virtualDaaScore: '42' }),
    getUtxosByAddresses: async () => ({ entries: [{ transactionId: 'a'.repeat(64), index: 0, amount: '10', scriptPublicKey: 'script' }] }),
    getFeeEstimate: async () => ({ estimate: { priorityBucket: [{ feerate: 123 }] } }),
    submitSafeJson: async () => 'b'.repeat(64),
  };
  const adapter = new KaspaChainAdapter({ rpc });
  assert.equal(await adapter.getCurrentDaaScore(), 42n);
  assert.equal((await adapter.getUtxos('kaspatest:address')).entries.length, 1);
  assert.equal(await adapter.getPriorityFeerate(), 123);
  assert.equal(await adapter.submitSafeJson('{}'), 'b'.repeat(64));
});

test('gateway rejects malformed chain responses', async () => {
  const adapter = new KaspaChainAdapter({
    rpc: {
      getBlockDagInfo: async () => ({}),
      getUtxosByAddresses: async () => ({ invalid: true }),
    },
  });
  await assert.rejects(() => adapter.getCurrentDaaScore(), { code: 'RPC_INVALID_RESPONSE' });
  await assert.rejects(() => adapter.getUtxos('kaspatest:address'), { code: 'RPC_INVALID_RESPONSE' });
});
