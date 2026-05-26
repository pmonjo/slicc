// Interfaces all live in @slicc/cloud-core now. The CLI keeps the
// `createSubstrate` factory here until Task A5 moves it (and the e2b
// adapter) into cloud-core. Until then, this file re-exports the
// interfaces and provides the factory.

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

import type {
  SubstrateConfig,
  SandboxSubstrate,
  SubstrateId,
  SubstrateFactory,
} from '@slicc/cloud-core';
import { createE2bSubstrate } from './substrates/e2b.js';

export const createSubstrate: SubstrateFactory = (id, cfg) => {
  if (id === 'e2b') return createE2bSubstrate(cfg);
  // SubstrateId is currently the literal 'e2b'; this branch is unreachable today.
  throw new Error(`unknown substrate: ${id}`);
};
