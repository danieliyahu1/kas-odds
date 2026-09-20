// Node entry point for KasOdds covenant derivation.
//
// Loads the pinned template artifact from disk and re-exports the pure core
// (kasodds-core.mjs) with a `Buffer`-backed `deriveGameInstance` so existing
// Node callers and tests keep their `.toString('hex')` behavior unchanged.
// The browser imports kasodds-core.mjs directly and supplies the artifact
// fetched over HTTP.
import {
  deriveGameInstance as deriveCore,
  verifyTemplateHash as verifyCore,
  parseCovenantAddress as parseAddressCore,
} from './kasodds-core.mjs';
import { getCovenantTemplate } from './template.mjs';

export const KASODDS_TEMPLATE = getCovenantTemplate();

export function verifyTemplateHash(template = KASODDS_TEMPLATE) {
  return verifyCore(template);
}

export function deriveGameInstance(game, opts = {}) {
  const template = opts.template || KASODDS_TEMPLATE;
  const result = deriveCore(game, { ...opts, template });
  return Object.freeze({
    ...result,
    redeemScript: Buffer.from(result.redeemScript),
    p2shScript: Buffer.from(result.p2shScript),
  });
}

export function parseCovenantAddress(address) {
  return parseAddressCore(address);
}
