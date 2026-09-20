// Client-side transaction verification for KasOdds.
//
// The backend may prepare a transaction, but it must never be trusted with
// intent. Before KasWare is asked to sign, the browser independently recomputes
// the covenant instance from the player's own commitment, side, and stake and
// checks that the prepared transaction locks the exact expected covenant
// output. A mismatched commitment, side, stake, or covenant binding is refused
// here, so a compromised server cannot substitute a different game.
import { deriveGameInstance, parseTemplateArtifact, verifyTemplateHash, bytesToHex, hexToBytes } from '/src/covenant/kasodds-core.mjs';
import { blake2b256 } from '/src/hashes/blake2b.mjs';
import { createGenesisGameOutput } from '/src/genesis-transaction.js';
import { AUTOMATION_FEE_SOMPI } from '/src/protocol.js';
import { verifyTransactionIntent } from '/src/transaction-intent.js';

const SOMPI_PER_KAS = 100_000_000n;

let templatePromise = null;

export async function loadCovenantTemplate() {
  if (!templatePromise) {
    templatePromise = fetch('/covenant/kasodds.template.artifact.json')
      .then((response) => {
        if (!response.ok) throw new Error('Covenant artifact could not be loaded');
        return response.json();
      })
      .then(parseTemplateArtifact);
  }
  return templatePromise;
}

export async function deriveCovenant({ creatorPublicKey, creatorCommitment, side, stakeSompi, deadlineDaa, gameFeePublicKey, addressPrefix }) {
  const template = await loadCovenantTemplate();
  verifyTemplateHash(template);
  const gameWalletHash = bytesToHex(blake2b256(hexToBytes(gameFeePublicKey))).toLowerCase();
  return deriveGameInstance({
    creatorPubkey: creatorPublicKey,
    creatorCommit: creatorCommitment,
    stakeSompi,
    deadlineDaa,
    creatorEven: side === 'even',
    gameWalletHash,
    settleFee: AUTOMATION_FEE_SOMPI,
  }, { template, addressPrefix });
}

export async function verifyCreation({ txJson, creatorPublicKey, creatorCommitment, side, stakeKas, deadlineDaa, gameFeePublicKey, feeSompi, changeScriptPublicKey, addressPrefix }) {
  const stakeSompi = BigInt(stakeKas) * SOMPI_PER_KAS;
  const instance = await deriveCovenant({ creatorPublicKey, creatorCommitment, side, stakeSompi, deadlineDaa: BigInt(deadlineDaa), gameFeePublicKey, addressPrefix });

  let transaction;
  try {
    transaction = JSON.parse(txJson);
  } catch {
    throw new Error('Prepared transaction is not valid SafeJSON');
  }
  if (!Array.isArray(transaction.inputs) || transaction.inputs.length === 0) {
    throw new Error('Prepared transaction has no funding inputs');
  }

  const covenantScriptPublicKey = bytesToHex(instance.p2shScript);
  const expected = createGenesisGameOutput({
    request: { stakeSompi, covenantScriptPublicKey },
    authorizingInput: 0,
    authorizingOutpoint: transaction.inputs[0],
  });

  const actual = transaction.outputs?.[0];
  const covenant = actual?.covenant ?? {};
  if (!actual
    || actual.value !== expected.value
    || actual.scriptPublicKey !== expected.scriptPublicKey
    || Number(covenant.authorizingInput) !== expected.covenant.authorizingInput
    || String(covenant.covenantId ?? '').toLowerCase() !== expected.covenant.covenantId) {
    throw new Error('Prepared game does not match your number, side, and stake');
  }
  if (feeSompi !== undefined) {
    const totalIn = transaction.inputs.reduce((sum, input) => sum + BigInt(input?.utxo?.amount ?? 0), 0n);
    const totalOut = transaction.outputs.reduce((sum, output) => sum + BigInt(output?.value ?? 0), 0n);
    const actualFee = totalIn - totalOut;
    if (actualFee !== BigInt(feeSompi) || actualFee < 0n) throw new Error('Prepared transaction fee does not match the approved fee');
    if (transaction.outputs.length > 2) throw new Error('Prepared transaction has an unexpected output');
    if (transaction.outputs.length === 2
      && (transaction.outputs[1].scriptPublicKey !== changeScriptPublicKey || transaction.outputs[1].covenant !== null)) {
      throw new Error('Prepared change output does not return to the approved creator script');
    }
  }

  const signInputs = transaction.inputs
    .map((input, index) => ({ input, index }))
    .filter(({ input }) => input?.signatureScript === '')
    .map(({ index }) => ({ index, sighashType: 1 }));
  if (signInputs.length === 0) throw new Error('Prepared transaction has no wallet inputs to sign');

  return Object.freeze({
    templateHash: instance.templateHash,
    covenantId: expected.covenant.covenantId,
    covenantAddress: instance.address,
    signInputs,
  });
}

export { verifyTransactionIntent };

export function verifyPreparedTransaction(prepared, action) {
  if (!prepared?.verification || prepared.verification.action !== action) {
    throw new Error('The server did not provide a complete transaction intent');
  }
  return verifyTransactionIntent({ action, txJson: prepared.txJson, intent: prepared.verification });
}

export function parseTemplateHash() {
  return loadCovenantTemplate().then((template) => template.templateHash);
}
