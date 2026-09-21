// Isomorphic covenant template provider.
//
// One covenant is pinned: the staked KasOdds game. Node auto-loads the artifact
// from disk (top-level await). The browser fetches the same artifact over HTTP
// and parses it (see public/verify.js). Shared builders read it through
// `getCovenantTemplate` so they never import the Node-only `kasodds.mjs` loader.
import { parseTemplateArtifact } from './kasodds-core.mjs';
import { ProtocolError } from '../protocol.js';

const ARTIFACT_FILE = 'kasodds.template.artifact.json';
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

let template = null;

if (!isBrowser) {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const artifactPath = fileURLToPath(new URL(`../../covenant/${ARTIFACT_FILE}`, import.meta.url));
  template = parseTemplateArtifact(JSON.parse(readFileSync(artifactPath, 'utf8')));
}

export function getCovenantTemplate() {
  if (!template) {
    throw new ProtocolError('ARTIFACT_MISMATCH', 'Covenant template is not loaded; the browser must fetch and parse the pinned artifact first');
  }
  return template;
}
