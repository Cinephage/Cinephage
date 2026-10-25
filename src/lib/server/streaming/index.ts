/**
 * Streaming Module
 *
 * Provides streaming functionality for Cinephage including:
 * - Cinephage API-backed playback sessions
 * - HLS playlist parsing and best quality selection
 * - STRM file generation and management
 * - Shared HTTP utilities for providers
 */

// Core types
export * from './types';

// Configuration constants
export * from './constants';

// HLS parsing
export * from './hls';

// STRM file service
export * from './StrmService';

// URL utilities
export * from './url';

// Settings helper
export * from './settings';

// Shared HTTP utilities (also available via ./utils)
export { fetchWithTimeout, checkStreamAvailability, checkHlsAvailability } from './utils';

// Cinephage API playback services
// Note: the legacy `streaming/cinephage-api/CinephageApiService` was moved to
// the CinephageAPI subsystem (`#lib/server/cinephage/modules/remote-streaming`).
// Consumers should import RemoteStreamingModule from there directly.
export * from './sessions/session-store';
export * from './sessions/PlaybackSessionService';
export * from './sessions/SessionProxyService';
