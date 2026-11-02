/**
 * SSE Module - Server-Sent Events for Svelte
 *
 * A fully reactive, Svelte-native SSE connection manager.
 *
 * @example
 * import { createSSE } from '#lib/sse/index.js';
 *
 * const sse = createSSE('/api/stream', {
 *   'event:name': (data) => console.log(data)
 * });
 *
 * {#if sse.isConnected}
 *   <span>Connected</span>
 * {/if}
 */

// Main API
export { createSSE, createDynamicSSE } from './create-sse.svelte.js';

// Types
export type {
	SSEState,
	SSEStatus,
	SSEError,
	SSEErrorType,
	SSEHandlers,
	SSEOptions,
	SSEConnectedEvent,
	SSEHeartbeatEvent
} from './types.js';
