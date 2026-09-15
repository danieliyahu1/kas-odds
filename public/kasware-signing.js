// KasWare signing request construction for Even/Odd.
//
// KasWare's signPskt signs every input with SighashType.All when signInputs is
// omitted, which overwrites a covenant input's KCC invocation. Only inputs the
// wallet actually owns may be signed: funding inputs are prepared with an empty
// signature script, while covenant inputs already carry their entry script.
const SIGHASH_ALL = 1;

export function signingInputsFor(txJson) {
  let transaction;
  try {
    transaction = JSON.parse(txJson);
  } catch {
    throw new Error('Prepared transaction is not valid JSON');
  }
  const inputs = Array.isArray(transaction?.inputs) ? transaction.inputs : [];
  const signInputs = inputs
    .map((input, index) => ({ input, index }))
    .filter(({ input }) => !input?.signatureScript)
    .map(({ index }) => ({ index, sighashType: SIGHASH_ALL }));
  if (signInputs.length === 0) throw new Error('Prepared transaction has no wallet inputs to sign');
  return signInputs;
}

export function signWithKasware(provider, txJson, signInputs) {
  return provider.signPskt({ txJsonString: txJson, options: { signInputs: signInputs ?? signingInputsFor(txJson) } });
}
