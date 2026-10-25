/**
 * Subtitle Batch Progress Store
 *
 * Svelte 5 runes-based store for subtitle batch auto-search progress via SSE streaming.
 * Follows the same pattern as searchProgress.svelte.ts.
 */

import type { SubtitleBatchAutoSearchRequest } from '#lib/validation/schemas.js';

export type SubtitleProgressStatus =
	| 'searching'
	| 'downloaded'
	| 'not_found'
	| 'no_results'
	| 'below_threshold'
	| 'no_file'
	| 'not_monitored'
	| 'opted_out'
	| 'no_profile'
	| 'satisfied'
	| 'error';

export interface SubtitleProgressUpdate {
	current: number;
	total: number;
	episodeId?: string;
	movieId?: string;
	title: string;
	status: SubtitleProgressStatus;
	reason?: string;
	seasonNumber?: number;
	episodeNumber?: number;
	bestRejectedScore?: number;
	bestRejectedReason?: string;
	subtitle?: {
		language: string;
		matchScore: number;
		providerName: string;
	};
}

export interface SubtitleBatchResults {
	success: boolean;
	total: number;
	downloaded: number;
	notFound: number;
	skipped?: number;
	errors: number;
	reasons?: Record<string, number>;
	error?: string;
}

export interface SubtitleBatchState {
	isActive: boolean;
	current: number;
	total: number;
	currentTitle: string;
	currentStatus: SubtitleProgressStatus;
}

export function createSubtitleProgress() {
	let state = $state<SubtitleBatchState>({
		isActive: false,
		current: 0,
		total: 0,
		currentTitle: '',
		currentStatus: 'searching'
	});

	let results = $state<SubtitleBatchResults | null>(null);
	let items = $state<SubtitleProgressUpdate[]>([]);

	async function startBatch(
		payload: SubtitleBatchAutoSearchRequest
	): Promise<SubtitleBatchResults> {
		return new Promise((resolve, reject) => {
			state = {
				isActive: true,
				current: 0,
				total: 0,
				currentTitle: 'Starting...',
				currentStatus: 'searching'
			};
			results = null;
			items = [];

			fetch('/api/subtitles/auto-search/batch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			})
				.then(async (response) => {
					if (!response.ok) {
						const error = await response.json();
						throw new Error(error.error || 'Batch subtitle search failed');
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
							if (line.startsWith(':')) continue;
							if (line.startsWith('event: ')) {
								eventType = line.slice(7).trim();
							} else if (line.startsWith('data: ')) {
								try {
									eventData = JSON.parse(line.slice(6));
								} catch {
									eventData = null;
								}
							} else if (line === '' && eventType) {
								handleEvent(eventType, eventData);

								if (eventType === 'subtitle:completed') {
									state.isActive = false;
									results = eventData as SubtitleBatchResults;
									resolve(results);
									return;
								}

								eventType = '';
								eventData = null;
							}
						}
					}

					if (!completed) {
						state.isActive = false;
						reject(new Error('Subtitle search stream ended unexpectedly'));
					}
				})
				.catch((error) => {
					state.isActive = false;
					reject(error);
				});
		});
	}

	function handleEvent(eventType: string, data: unknown) {
		switch (eventType) {
			case 'subtitle:started': {
				const d = data as { total: number; type: string };
				state.total = d.total;
				state.current = 0;
				state.currentTitle = 'Starting...';
				break;
			}
			case 'subtitle:progress': {
				const d = data as SubtitleProgressUpdate;
				state.current = d.current;
				state.total = d.total;
				state.currentTitle = d.title;
				state.currentStatus = d.status;
				items = [...items, d];
				break;
			}
			case 'subtitle:completed':
				state.isActive = false;
				state.currentStatus = 'downloaded';
				break;
		}
	}

	function reset() {
		state = {
			isActive: false,
			current: 0,
			total: 0,
			currentTitle: '',
			currentStatus: 'searching'
		};
		results = null;
		items = [];
	}

	return {
		get state() {
			return state;
		},
		get results() {
			return results;
		},
		get items() {
			return items;
		},
		startBatch,
		reset
	};
}
