import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { movies } from '#lib/server/db/schema.js';
import { tmdb } from '#lib/server/tmdb.js';
import { createChildLogger } from '#lib/logging/index.js';
import { deriveAvailability, firstDownloadableDate, isSearchable, windowsFrom } from './derive.js';
import type { Availability, AvailabilityInput } from './derive.js';
import { listEvents, pruneEvents, upsertEvents } from './event-store.js';
import type { AvailabilityLevel, NewReleaseEvent, ReleaseEvent, ReleaseKind } from './types.js';
import { isDownloadable } from './types.js';
import { buildReleaseProviderRegistry } from './providers/types.js';

const logger = createChildLogger({ module: 'AvailabilityService', logDomain: 'system' });

/** The subset of a `movies` row this service needs. */
export interface MovieAvailabilityRef {
	id: string;
	tmdbId: number | null;
	hasFile?: boolean | null;
	minimumAvailability?: string | null;
}

export interface RefreshResult {
	fetched: number;
	written: number;
	pruned: number;
	skipped: boolean;
}

/**
 * Read facade over release events.
 *
 * Callers ask questions ("is this searchable?", "what's next?") rather than
 * reading date columns, so the storage shape can change without touching them.
 */
export class AvailabilityService {
	async getEvents(
		mediaType: 'movie' | 'series' | 'episode',
		mediaId: string
	): Promise<ReleaseEvent[]> {
		return listEvents(mediaType, mediaId);
	}

	async getAvailability(movie: MovieAvailabilityRef): Promise<Availability> {
		const events = await listEvents('movie', movie.id);
		return deriveAvailability(this.toInput(movie, events));
	}

	async isSearchable(movie: MovieAvailabilityRef): Promise<boolean> {
		const events = await listEvents('movie', movie.id);
		return isSearchable(this.toInput(movie, events));
	}

	/**
	 * Fetch from the configured provider, upsert the events it is authoritative
	 * for, prune what it no longer reports, and refresh the legacy column cache.
	 */
	async refreshMovie(movie: MovieAvailabilityRef): Promise<RefreshResult> {
		if (!movie.tmdbId) return { fetched: 0, written: 0, pruned: 0, skipped: true };

		const region = await tmdb.getRegion();
		const registry = await buildReleaseProviderRegistry();
		const provider = registry.providers.find((candidate) =>
			candidate.supportedMediaTypes.includes('movie')
		);

		if (!provider || !(await provider.isConfigured())) {
			return { fetched: 0, written: 0, pruned: 0, skipped: true };
		}

		let fetched: NewReleaseEvent[];
		try {
			fetched = await provider.fetch(
				{ mediaType: 'movie', mediaId: movie.id, tmdbId: movie.tmdbId },
				{ region, timeoutMs: 15_000 }
			);
		} catch (error) {
			logger.warn(
				{ err: error, movieId: movie.id, tmdbId: movie.tmdbId },
				'[Availability] Provider fetch failed - keeping stored events'
			);
			return { fetched: 0, written: 0, pruned: 0, skipped: false };
		}

		const owned = fetched.filter((event) => provider.authority.includes(event.kind));
		if (owned.length === 0) return { fetched: 0, written: 0, pruned: 0, skipped: false };

		return this.persist(provider.id, movie.id, owned);
	}

	/**
	 * Record events a caller already fetched (e.g. `MetadataRefreshTask`, which
	 * holds the TMDB payload and must not pay for a second request).
	 */
	async recordEvents(movieId: string, events: readonly NewReleaseEvent[]): Promise<RefreshResult> {
		if (events.length === 0) return { fetched: 0, written: 0, pruned: 0, skipped: true };
		return this.persist('tmdb', movieId, events);
	}

	private async persist(
		source: string,
		movieId: string,
		events: readonly NewReleaseEvent[]
	): Promise<RefreshResult> {
		const written = await upsertEvents(events);
		const pruned = await pruneEvents(
			'movie',
			movieId,
			source,
			events.map((event) => event.sourceId ?? '').filter(Boolean)
		);

		const stored = await listEvents('movie', movieId);
		await this.writeMovieCache(movieId, stored);

		return { fetched: events.length, written, pruned, skipped: false };
	}

	/** Load a movie row and refresh it. Returns null when the movie is gone. */
	async refreshMovieById(movieId: string): Promise<RefreshResult | null> {
		const row = await db
			.select({
				id: movies.id,
				tmdbId: movies.tmdbId,
				hasFile: movies.hasFile,
				minimumAvailability: movies.minimumAvailability
			})
			.from(movies)
			.where(eq(movies.id, movieId))
			.get();

		if (!row) return null;
		return this.refreshMovie(row);
	}

	/**
	 * Keep `movies.*release*` in step with the events. These columns are a
	 * materialised summary for list views and the arr API — the events remain
	 * the source of truth.
	 */
	private async writeMovieCache(movieId: string, events: readonly ReleaseEvent[]): Promise<void> {
		const windows = windowsFrom(events);
		const firstDownloadable = events
			.filter((event) => isDownloadable(event.kind))
			.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate))[0];

		await db
			.update(movies)
			.set({
				releaseDate: windows.theatrical,
				digitalReleaseDate: windows.digital,
				physicalReleaseDate: windows.physical,
				downloadReleaseDate: firstDownloadableDate(events),
				downloadReleaseType: firstDownloadable ? (firstDownloadable.kind as ReleaseKind) : null
			})
			.where(eq(movies.id, movieId));
	}

	private toInput(movie: MovieAvailabilityRef, events: ReleaseEvent[]): AvailabilityInput {
		return {
			events,
			hasFile: Boolean(movie.hasFile),
			minimumAvailability: normalizeLevel(movie.minimumAvailability)
		};
	}
}

function normalizeLevel(value: string | null | undefined): AvailabilityLevel {
	return value === 'announced' || value === 'inCinemas' ? value : 'released';
}

let instance: AvailabilityService | null = null;

export function getAvailabilityService(): AvailabilityService {
	instance ??= new AvailabilityService();
	return instance;
}

/** Test hook: drop the singleton so a fresh service is built. */
export function resetAvailabilityService(): void {
	instance = null;
}
