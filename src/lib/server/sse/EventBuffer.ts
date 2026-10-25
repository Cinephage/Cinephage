/**
 * Event Buffer Service for SSE
 *
 * Solves the race condition where events are emitted before
 * the SSE connection is established by buffering recent events
 * and replaying them on connection.
 */

import type { QualityInfo, MediaInfo } from '#lib/types/library.js';

interface BufferedFileImportedEvent {
	timestamp: number;
	mediaType: 'movie' | 'episode';
	seriesId?: string;
	movieId?: string;
	seasonNumber?: number;
	episodeIds?: string[];
	file: {
		id: string;
		relativePath: string;
		size: number | undefined;
		dateAdded: string;
		sceneName?: string;
		releaseGroup?: string;
		releaseType?: string;
		quality: QualityInfo | null;
		mediaInfo: MediaInfo | null;
		languages?: string[];
		edition?: string;
	};
	wasUpgrade: boolean;
	replacedFileIds?: string[];
}

const BUFFER_SIZE = 100;
const BUFFER_TTL_MS = 300000; // 5 minutes

class EventBuffer {
	private buffer: BufferedFileImportedEvent[] = [];

	/**
	 * Add an event to the buffer
	 */
	add(event: BufferedFileImportedEvent): void {
		// Remove expired events
		const now = Date.now();
		this.buffer = this.buffer.filter((e) => now - e.timestamp < BUFFER_TTL_MS);

		// Add new event
		this.buffer.push(event);

		// Trim to max size
		if (this.buffer.length > BUFFER_SIZE) {
			this.buffer = this.buffer.slice(-BUFFER_SIZE);
		}
	}

	/**
	 * Get recent events for a specific movie
	 */
	getRecentMovieEvents(
		movieId: string,
		sinceMs: number = BUFFER_TTL_MS
	): BufferedFileImportedEvent[] {
		const cutoff = Date.now() - sinceMs;
		return this.buffer.filter(
			(e) => e.mediaType === 'movie' && e.movieId === movieId && e.timestamp > cutoff
		);
	}

	/**
	 * Get recent events for a specific series
	 */
	getRecentSeriesEvents(
		seriesId: string,
		sinceMs: number = BUFFER_TTL_MS
	): BufferedFileImportedEvent[] {
		const cutoff = Date.now() - sinceMs;
		return this.buffer.filter(
			(e) => e.mediaType === 'episode' && e.seriesId === seriesId && e.timestamp > cutoff
		);
	}

	/**
	 * Clear all buffered events
	 */
	clear(): void {
		this.buffer = [];
	}
}

// Singleton instance
export const eventBuffer = new EventBuffer();

// Export types
export type { BufferedFileImportedEvent };
