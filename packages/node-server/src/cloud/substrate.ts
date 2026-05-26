// Interfaces, e2b adapter, and the createSubstrate factory all live in
// @slicc/cloud-core now. This file is a thin re-export shim that
// preserves the existing `./substrate.js` import path for node-server's
// cloud-command files. Removed in Task A15.

export type {
  SandboxSubstrate,
  SandboxHandle,
  CreateOpts,
  RunResult,
  SandboxInfo,
  SubstrateConfig,
  SubstrateId,
  ListOpts,
  SubstrateFactory,
  SandboxSummary,
} from '@slicc/cloud-core';

export { createSubstrate } from '@slicc/cloud-core';
