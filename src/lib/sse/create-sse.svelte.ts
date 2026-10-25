/**
 * createSSE - Svelte-native Server-Sent Events hook
 *
 * A fully reactive SSE connection manager using Svelte 5 runes.
 * Automatically handles lifecycle, cleanup, reconnection, and tab visibility.
 *
 * @example
 * const sse = createSSE('/api/stream', {
 *   'event:name': (data) => handleEvent(data)
 * });
 *
 * {#if sse.isConnected}
 *   <span>Connected</span>
 * {/if}
 */

import { browser } from '$app/env';
import { afterNavigate, beforeNavigate } from '$app/navigation';
import type {
	SSEHandlers,
	SSEOptions,
	SSEState,
	SSEStatus,
	SSEError,
	SSEConnectedEvent,
	SSEHeartbeatEvent
} from './types.js';
import { DEFAULT_SSE_OPTIONS } from './types.js';
import { classifyError, createSSEError } from './errors.js';

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(attempt: number, baseDelay: number, maxDelay: number): number {
	return Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
}

/**
 * Create a reactive SSE connection
 *
 * @param url - SSE endpoint URL
 * @param handlers - Event handlers map
 * @param options - Configuration options
 * @returns Reactive SSE state object
 */
export function createSSE<T = Record<string, unknown>>(
	url: string | (() => string),
	handlers: SSEHandlers<T>,
	options: SSEOptions = {}
): SSEState {
	const config = { ...DEFAULT_SSE_OPTIONS, ...options };
	const getUrl = typeof url === 'function' ? url : () => url;

	let status = $state<SSEStatus>('idle');
	let error = $state<SSEError | null>(null);
	let reconnectCount = $state(0);
	let isPaused = $state(false);
	let maxRetriesExceeded = $state(false);

	let eventSource: EventSource | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let isManuallyClosed = false;
	let lastUrl = getUrl();
	let lastServerActivity = Date.now();

	const activeListeners: Array<{ event: string; handler: (e: MessageEvent) => void }> = [];

	function setStatus(newStatus: SSEStatus): void {
		status = newStatus;
	}

	function markServerActivity(): void {
		lastServerActivity = Date.now();
	}

	function scheduleReconnect(): void {
		if (isManuallyClosed || isPaused) {
			return;
		}

		if (reconnectCount < config.maxRetries) {
			setStatus('error');

			const delay = getBackoffDelay(reconnectCount, config.baseDelay, config.maxDelay);

			reconnectTimer = setTimeout(() => {
				reconnectCount++;
				connect();
			}, delay);
			return;
		}

		setStatus('error');
		maxRetriesExceeded = true;
	}

	function setupHeartbeat(): void {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
		}

		const staleAfterMs = config.heartbeatInterval * 2 + 5000;
		const checkIntervalMs = Math.max(5000, Math.min(config.heartbeatInterval, 15000));
		heartbeatTimer = setInterval(() => {
			if (!eventSource || eventSource.readyState !== EventSource.OPEN) {
				return;
			}

			const elapsedMs = Date.now() - lastServerActivity;
			if (elapsedMs <= staleAfterMs) {
				return;
			}

			const elapsedSeconds = Math.floor(elapsedMs / 1000);
			const timeoutError = createSSEError('timeout', `No SSE activity for ${elapsedSeconds}s`);
			error = timeoutError;
			handlers.error?.(timeoutError);
			closeConnection();
			scheduleReconnect();
		}, checkIntervalMs);
	}

	function clearTimers(): void {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
	}

	function closeConnection(nextStatus: SSEStatus = 'closed'): void {
		clearTimers();

		if (eventSource) {
			for (const { event, handler } of activeListeners) {
				eventSource.removeEventListener(event, handler as EventListener);
			}
			activeListeners.length = 0;
			eventSource.onerror = null;

			eventSource.close();
			eventSource = null;
		}

		setStatus(nextStatus);
	}

	function connect(nextUrl = getUrl()): void {
		if (!browser || isManuallyClosed || isPaused) {
			return;
		}

		if (!nextUrl) {
			closeConnection('closed');
			return;
		}

		if (eventSource?.readyState === EventSource.OPEN) {
			return;
		}

		closeConnection();

		setStatus('connecting');

		try {
			eventSource = new EventSource(nextUrl);

			const onOpen = () => {
				setStatus('connected');
				reconnectCount = 0;
				error = null;
				markServerActivity();
				setupHeartbeat();
			};
			eventSource.addEventListener('open', onOpen);
			activeListeners.push({ event: 'open', handler: onOpen });

			const onConnected = (e: MessageEvent) => {
				markServerActivity();
				try {
					const data = JSON.parse(e.data) as SSEConnectedEvent;
					handlers.connected?.(data);
				} catch {
					// Ignore parse errors for connected event
				}
			};
			eventSource.addEventListener('connected', onConnected);
			activeListeners.push({ event: 'connected', handler: onConnected });

			const onHeartbeat = (e: MessageEvent) => {
				markServerActivity();
				try {
					const data = JSON.parse(e.data) as SSEHeartbeatEvent;
					handlers.heartbeat?.(data);
				} catch {
					// Ignore parse errors for heartbeat
				}
			};
			eventSource.addEventListener('heartbeat', onHeartbeat);
			activeListeners.push({ event: 'heartbeat', handler: onHeartbeat });

			for (const [eventName, handler] of Object.entries(handlers)) {
				if (eventName === 'connected' || eventName === 'heartbeat' || eventName === 'error') {
					continue;
				}

				const listener = (e: MessageEvent) => {
					markServerActivity();
					try {
						const data = JSON.parse(e.data);
						handler?.(data);
					} catch {
						// Ignore parse errors for custom events
					}
				};
				eventSource.addEventListener(eventName, listener);
				activeListeners.push({ event: eventName, handler: listener });
			}

			eventSource.onerror = (e) => {
				if (isManuallyClosed) return;

				const { type, message } = classifyError(e);
				const nextError = createSSEError(type, message);
				error = nextError;

				handlers.error?.(nextError);

				closeConnection();

				scheduleReconnect();
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Unknown error';
			const nextError = createSSEError('client', message);
			error = nextError;
			setStatus('error');
			handlers.error?.(nextError);
			scheduleReconnect();
		}
	}

	function close(): void {
		isManuallyClosed = true;
		closeConnection('closed');
	}

	function reconnect(): void {
		isManuallyClosed = false;
		reconnectCount = 0;
		maxRetriesExceeded = false;
		connect();
	}

	afterNavigate(({ shallow, type }) => {
		if (shallow && type === 'goto') return;
		if (!browser) return;
		connect();
	});

	beforeNavigate((navigation) => {
		if (navigation.shallow && navigation.type === 'goto') return;

		if (navigation.willUnload) {
			closeConnection('closed');
		}
	});

	$effect(() => {
		return () => {
			closeConnection('closed');
		};
	});

	$effect(() => {
		const resolvedUrl = getUrl();
		if (resolvedUrl !== lastUrl) {
			lastUrl = resolvedUrl;
			reconnectCount = 0;
			isManuallyClosed = false;
			closeConnection(); // force-close before reconnect so the open-connection guard in connect() doesn't skip it
			connect(resolvedUrl);
		}
	});

	$effect(() => {
		if (!browser || !config.pauseOnHidden) return;

		function handleVisibilityChange(): void {
			if (document.hidden) {
				isPaused = true;
				closeConnection('paused');
			} else if (config.reconnectOnVisible) {
				isPaused = false;
				connect();
			}
		}

		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	});

	$effect(() => {
		if (!browser) return;

		function handleOnline(): void {
			if (status === 'offline') {
				connect();
			}
		}

		function handleOffline(): void {
			closeConnection('offline');
		}

		window.addEventListener('online', handleOnline);
		window.addEventListener('offline', handleOffline);

		return () => {
			window.removeEventListener('online', handleOnline);
			window.removeEventListener('offline', handleOffline);
		};
	});

	return {
		get status() {
			return status;
		},
		get error() {
			return error;
		},
		get isConnected() {
			return status === 'connected';
		},
		get isPaused() {
			return isPaused;
		},
		get reconnectCount() {
			return reconnectCount;
		},
		get maxRetriesExceeded() {
			return maxRetriesExceeded;
		},
		close,
		reconnect
	};
}

/**
 * Create a reactive SSE connection with dynamic URL
 *
 * Automatically reconnects when the URL changes.
 *
 * @example
 * const sse = createDynamicSSE(
 *   () => `/api/stream?id=${movieId}`,
 *   { 'event': handler }
 * );
 */
export function createDynamicSSE<T = Record<string, unknown>>(
	getUrl: () => string,
	handlers: SSEHandlers<T>,
	options: SSEOptions = {}
): SSEState {
	return createSSE(getUrl, handlers, options);
}
