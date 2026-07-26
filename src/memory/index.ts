export { MemoryManager } from './memory-manager.js';
export type { MemoryEntry, MemoryIndexEntry, MemoryType } from './types.js';

// Wave C CRC-3 (M-043): Typed Memory Candidate
export {
  createTypedMemoryCandidate,
  MEMORY_CANDIDATE_PROTOCOL_VERSION,
  type TypedMemoryCandidate,
  type AutoMemoryType,
  type CreateTypedMemoryCandidateInput,
} from './candidates.js';

// Wave D DRC-2 (M-044): Memory Admission + Use
export {
  decideMemoryAdmission,
  decideMemoryUse,
  type MemoryAdmissionInput,
  type MemoryAdmissionDecision,
  type MemoryAdmissionPolicy,
  type MemoryUseInput,
  type MemoryUseDecision,
} from './admission.js';

// Wave E ERC-2 (M-045/M-046): Memory Persistence + Catalog + Selection
export {
  prepareMemoryPersistence,
  commitMemoryDetails,
  recoverMemoryPersistence,
  persistAndSelectMemory,
  type MemoryPersistenceRecord,
  type MemoryPersistenceTransaction,
  type MemoryLifecycleOperationRequest,
  type MemoryLifecycleOperationResult,
} from './persistence.js';

export {
  buildMemoryCatalogSnapshot,
  commitMemoryCatalog,
  type MemoryCatalogEntry,
  type MemoryCatalogSnapshot,
  type CatalogCommitResult,
  type GovernedCatalogStore,
} from './catalog.js';

export {
  buildMemorySearchQuery,
  selectMemoryEntries,
  retrieveSelectedMemory,
  type MemorySearchQuery,
  type MemorySelectionResult,
  type MemoryRetrievalResult,
} from './selection.js';

export {
  buildLegacyCatalogSnapshot,
  type LegacyCatalogSnapshot,
} from './legacy-adapter.js';
