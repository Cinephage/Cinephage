/**
 * Availability domain — release events and the answers derived from them.
 *
 * `release_events` is the source of truth for "when can this be watched or
 * grabbed". The `movies.*release*` columns are a materialised summary kept in
 * step by `AvailabilityService`, never written by feature code.
 *
 * Release *name* parsing lives in `src/lib/server/releases/` — unrelated.
 */

export * from './types.js';
export * from './derive.js';
export * from './AvailabilityService.js';
export * from './event-store.js';
export type { ReleaseProvider, ReleaseProviderRef } from './providers/types.js';
export { buildReleaseProviderRegistry } from './providers/types.js';
