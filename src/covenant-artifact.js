import { ProtocolError } from './protocol.js';

export function validateCovenantArtifact(artifact, expected, addressPrefix) {
  if (!artifact || typeof artifact !== 'object') {
    throw new ProtocolError('MISSING_ARTIFACT', 'A compiled SilverScript artifact is required');
  }
  const required = ['schemaVersion', 'compilerVersion', 'templateHash', 'bytecode', 'address'];
  for (const field of required) {
    if (typeof artifact[field] !== 'string' || artifact[field].length === 0) {
      throw new ProtocolError('INVALID_ARTIFACT', `Artifact field ${field} is required`);
    }
  }
  if (expected?.compilerVersion && artifact.compilerVersion !== expected.compilerVersion) {
    throw new ProtocolError('ARTIFACT_MISMATCH', 'SilverScript compiler revision is not pinned correctly');
  }
  if (expected?.templateHash && artifact.templateHash.toLowerCase() !== expected.templateHash.toLowerCase()) {
    throw new ProtocolError('ARTIFACT_MISMATCH', 'SilverScript template hash does not match the configured hash');
  }
  if (!/^[0-9a-f]{64}$/i.test(artifact.templateHash)) {
    throw new ProtocolError('INVALID_ARTIFACT', 'Artifact template hash must be 32 bytes');
  }
  if (!artifact.address.startsWith(`${addressPrefix}:`)) {
    throw new ProtocolError('INVALID_ARTIFACT', `Covenant address must target the ${addressPrefix} network`);
  }
  return Object.freeze({ ...artifact, templateHash: artifact.templateHash.toLowerCase() });
}
