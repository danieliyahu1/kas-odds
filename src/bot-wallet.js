// Server-held wallet for the fallback bot.
//
// Unlike a player, the bot is not a browser: it holds its own private key in the
// process and signs the prepared SafeJSON locally. It signs only the inputs the
// prepared transaction left unsigned (the bot's own funding inputs); the covenant
// input already carries its KCC entry script and must never be overwritten.
import { ProtocolError } from './protocol.js';
import { loadWasmSdk } from './wasm-loader.mjs';

// Kaspa consensus sighash used by the wallet path; matches KasWare's All.
const SIGHASH_ALL = 0;

export class BotWallet {
  constructor({ privateKeyHex, network }) {
    if (typeof privateKeyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(privateKeyHex)) {
      throw new ProtocolError('INVALID_BOT_KEY', 'Bot private key must be 32 bytes of hexadecimal');
    }
    const wasm = loadWasmSdk();
    this.network = network;
    this.privateKey = new wasm.PrivateKey(privateKeyHex.toLowerCase());
    // The protocol carries an x-only (32-byte) public key everywhere.
    this.publicKey = this.privateKey.toPublicKey().toXOnlyPublicKey().toString();
    this.address = this.privateKey.toAddress(network).toString();
  }

  sign(txJson) {
    const wasm = loadWasmSdk();
    let transaction;
    try {
      transaction = wasm.Transaction.deserializeFromSafeJSON(txJson);
    } catch (error) {
      throw new ProtocolError('INVALID_TRANSACTION', `Bot could not parse the prepared transaction: ${error?.message ?? error}`);
    }
    transaction.finalize();
    const unsigned = transaction.inputs
      .map((input, index) => ({ input, index }))
      .filter(({ input }) => !input?.signatureScript)
      .map(({ index }) => index);
    if (unsigned.length === 0) throw new ProtocolError('SIGNING_FAILED', 'Prepared transaction has no bot inputs to sign');
    for (const index of unsigned) {
      transaction.inputs[index].signatureScript = wasm.createInputSignature(transaction, index, this.privateKey, SIGHASH_ALL);
    }
    return transaction.serializeToSafeJSON();
  }
}
