// Client-side transaction verification for Even/Odd.
//
// The backend may prepare a transaction, but it must never be trusted with
// intent. Before KasWare is asked to sign, the browser independently recomputes
// the covenant instance from the player's own commitment, side, and stake and
// checks that the prepared transaction locks the exact expected covenant
// output. A mismatched commitment, side, stake, or covenant binding is refused
// here, so a compromised server cannot substitute a different game.
import { deriveGameInstance, parseTemplateArtifact, verifyTemplateHash, bytesToHex, hexToBytes } from '/src/covenant/even-odd-core.mjs';
import { blake2b256 } from '/src/hashes/blake2b.mjs';
import { createGenesisGameOutput } from '/src/genesis-transaction.js';
import { AUTOMATION_FEE_SOMPI } from '/src/protocol.js';

const SOMPI_PER_KAS = 100_000_000n;

let templatePromise = null;

export async function loadCovenantTemplate() {
  if (!templatePromise) {
    templatePromise = fetch('/covenant/even_odd.template.artifact.json')
      .then((response) => {
        if (!response.ok) throw new Error('Covenant artifact could not be loaded');
        return response.json();
      })
      .then(parseTemplateArtifact);
  }
  return templatePromise;
}

export async function deriveCovenant({ creatorPublicKey, creatorCommitment, side, stakeSompi, deadlineDaa, gameFeePublicKey }) {
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
  }, { template });
}

export async function verifyCreation({ txJson, creatorPublicKey, creatorCommitment, side, stakeKas, deadlineDaa, gameFeePublicKey }) {
  const stakeSompi = BigInt(stakeKas) * SOMPI_PER_KAS;
  const instance = await deriveCovenant({ creatorPublicKey, creatorCommitment, side, stakeSompi, deadlineDaa: BigInt(deadlineDaa), gameFeePublicKey });

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

  return Object.freeze({
    templateHash: instance.templateHash,
    covenantId: expected.covenant.covenantId,
    covenantAddress: instance.address,
  });
}

export function parseTemplateHash() {
  return loadCovenantTemplate().then((template) => template.templateHash);
}
