// All e2b substrate code lives in @slicc/cloud-core now. This shim exists
// so existing imports from `./substrates/e2b.js` (in this folder) keep
// resolving until subsequent tasks update callers to import from
// `@slicc/cloud-core` directly. Removed in Task A15.
export { createE2bSubstrate } from '@slicc/cloud-core';
