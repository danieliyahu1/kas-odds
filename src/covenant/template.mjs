// Isomorphic covenant template provider.
//
// Node auto-loads the pinned artifact from disk (top-level await). The browser
// loads the artifact over HTTP and calls `setCovenantTemplate` once at startup.
// Shared builders read it through `getCovenantTemplate()` so they never import
// the Node-only `kasodds.mjs` loader.
import { parseTemplateArtifact } from './kasodds-core.mjs';
import { ProtocolError } from '../protocol.js';

let template = null;
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

if (!isBrowser) {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const artifactPath = fileURLToPath(new URL('../../covenant/kasodds.template.artifact.json', import.meta.url));
  template = parseTemplateArtifact(JSON.parse(readFileSync(artifactPath, 'utf8')));
}

export function setCovenantTemplate(value) {
  if (!value) throw new ProtocolError('INVALID_ARTIFACT', 'A parsed covenant template is required');
  template = value;
  return template;
}

export function hasCovenantTemplate() {
  return Boolean(template);
}

export function getCovenantTemplate() {
  if (!template) throw new ProtocolError('ARTIFACT_MISMATCH', 'Covenant template is not loaded; call setCovenantTemplate in the browser');
  return template;
}
