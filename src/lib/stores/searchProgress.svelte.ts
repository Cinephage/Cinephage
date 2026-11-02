/**
 * Search Progress Store
 *
 * Svelte 5 runes-based store for handling search progress via SSE streaming.
 */

import type { SearchProgressUpdate } from '#lib/types/search.js';

export interface SearchState {
	isActive: boolean;
	phase: string;
	message: string;
	percentComplete: number;
	details?: {
		releaseName?: string;
		releaseType?: string;
		seasons?: number[];
		episodeCount?: number;
		score?: number;
		decision?: string;
		rejectionReason?: string;
		coveragePercent?: number;
	};
}

export interface SearchResults {
	success: boolean;
	error?: string;
	errors?: string[];
	issues?: Array<{
		code:
			| 'NO_DOWNLOAD_CLIENT'
			| 'NO_INDEXER_AVAILABLE'
			| 'INDEXER_TIMEOUT'
			| 'INDEXER_RATE_LIMITED'
			| 'GENERIC_ERROR';
		message: string;
		suggestion?: string;
		count?: number;
	}>;
	results?: unknown[];
	// Movie search fields
	found?: boolean;
	grabbed?: boolean;
	releaseName?: string;
	queueItemId?: string;
	// Series search fields
	summary?: {
		searched: number;
		found: number;
		grabbed: number;
		seasonPacksGrabbed?: number;
		individualEpisodesGrabbed?: number;
	};
	seasonPacks?: unknown[];
}

/**
 * Create a reactive search progress store
 */
export function createSearchProgress() {
	let state = $state<SearchState>({
		isActive: false,
		phase: '',
		message: '',
		percentComplete: 0
	});

	let results = $state<SearchResults | null>(null);
	let eventSource = $state<EventSource | null>(null);

	/**
	 * Start a search with SSE streaming
	 */
	async function startSearch(url: string, options?: RequestInit): Promise<SearchResults> {
		return new Promise((resolve, reject) => {
			// Reset state
			state = {
				isActive: true,
				phase: 'initializing',
				message: 'Starting search...',
				percentComplete: 0
			};
			results = null;

			// Close any existing connection
			if (eventSource) {
				eventSource.close();
			}

			// For POST requests with SSE response, we need to use fetch + ReadableStream
			// instead of EventSource since EventSource only supports GET
			fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				...options
			})
				.then(async (response) => {
					if (!response.ok) {
						const error = await response.json();
						throw new Error(error.error || 'Search failed');
					}

					if (!response.body) {
						throw new Error('No response body');
					}

					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = '';
					let eventType = '';
					let eventData: unknown = null;
					const completed = false;

					while (true) {
						const { done, value } = await reader.read();
						if (done) break;

						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';

						for (const line of lines) {
							if (line.startsWith(':')) continue; // Skip SSE comments (heartbeat keepalive)
							if (line.startsWith('event: ')) {
								eventType = line.slice(7).trim();
							} else if (line.startsWith('data: ')) {
								try {
									eventData = JSON.parse(line.slice(6));
								} catch {
									eventData = null;
								}
							} else if (line === '' && eventType) {
								// Process complete event
								handleEvent(eventType, eventData);

								if (eventType === 'search:completed') {
									state.isActive = false;
									results = eventData as SearchResults;
									resolve(results);
									return;
								}

								if (eventType === 'search:error') {
									state.isActive = false;
									results = eventData as SearchResults;
									reject(new Error(results.error || 'Search failed'));
									return;
								}

								// Reset for next event
								eventType = '';
								eventData = null;
							}
						}
					}

					// Stream ended without completion event
					if (!completed) {
						state.isActive = false;
						reject(new Error('Search stream ended unexpectedly'));
					}
				})
				.catch((error) => {
					state.isActive = false;
					state.message = error.message;
					reject(error);
				});
		});
	}

	/**
	 * Handle SSE events
	 */
	function handleEvent(eventType: string, data: unknown) {
		switch (eventType) {
			case 'search:started':
				state.phase = 'initializing';
				state.message = 'Search started...';
				state.percentComplete = 0;
				break;

			case 'search:progress': {
				const progress = data as SearchProgressUpdate;
				state.phase = progress.phase;
				state.message = progress.message;
				state.percentComplete = progress.percentComplete;
				state.details = progress.details;
				break;
			}

			case 'search:completed':
				state.isActive = false;
				state.phase = 'complete';
				state.percentComplete = 100;
				break;

			case 'search:error':
				state.isActive = false;
				state.phase = 'error';
				state.message = (data as { error?: string }).error || 'Search failed';
				break;
		}
	}

	/**
	 * Cancel the search
	 */
	function cancel() {
		if (eventSource) {
			eventSource.close();
			eventSource = null;
		}
		state.isActive = false;
	}

	/**
	 * Reset the store
	 */
	function reset() {
		cancel();
		state = {
			isActive: false,
			phase: '',
			message: '',
			percentComplete: 0
		};
		results = null;
	}

	return {
		get state() {
			return state;
		},
		get results() {
			return results;
		},
		startSearch,
		cancel,
		reset
	};
}
