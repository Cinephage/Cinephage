import type { RenamePreviewItem, RenamePreviewResult } from '#lib/library/naming/types.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';

interface MediaTypeCache {
	result: RenamePreviewResult;
	staleIds: Set<string>;
	fullyStale: boolean;
	/** Fingerprint of config + library shape at the time the result was computed. */
	fingerprint: string | null;
}

class RenamePreviewCacheStore {
	private movie: MediaTypeCache | null = null;
	private tv: MediaTypeCache | null = null;

	constructor() {
		libraryMediaEvents.onMovieUpdated(({ movieId }) => this.invalidateMovie(movieId));
		libraryMediaEvents.onSeriesUpdated(({ seriesId }) => this.invalidateSeries(seriesId));
		libraryMediaEvents.onLibraryDataChanged((event) => {
			// Per-entity events keep the rest of the cached result warm; anything
			// without an entity scope (bulk adds, root folder edits, reorganize,
			// config restores, manual imports) invalidates everything.
			if ((event.source === 'movie' || event.source === 'series') && event.entityId) {
				if (event.source === 'movie') this.invalidateMovie(event.entityId);
				else this.invalidateSeries(event.entityId);
				return;
			}
			this.invalidateAll();
		});
	}

	isFresh(mediaType: 'movie' | 'tv'): boolean {
		const c = mediaType === 'movie' ? this.movie : this.tv;
		return !!c && !c.fullyStale && c.staleIds.size === 0;
	}

	isPartiallyCached(mediaType: 'movie' | 'tv'): boolean {
		const c = mediaType === 'movie' ? this.movie : this.tv;
		return !!c && !c.fullyStale && c.staleIds.size > 0;
	}

	get(mediaType: 'movie' | 'tv'): RenamePreviewResult | null {
		const c = mediaType === 'movie' ? this.movie : this.tv;
		return c ? c.result : null;
	}

	getStaleIds(mediaType: 'movie' | 'tv'): Set<string> {
		const c = mediaType === 'movie' ? this.movie : this.tv;
		return c ? new Set(c.staleIds) : new Set();
	}

	set(
		mediaType: 'movie' | 'tv',
		result: RenamePreviewResult,
		fingerprint: string | null = null
	): void {
		const entry: MediaTypeCache = { result, staleIds: new Set(), fullyStale: false, fingerprint };
		if (mediaType === 'movie') this.movie = entry;
		else this.tv = entry;
	}

	getStoredFingerprint(mediaType: 'movie' | 'tv'): string | null {
		const c = mediaType === 'movie' ? this.movie : this.tv;
		return c ? c.fingerprint : null;
	}

	invalidateAll(): void {
		if (this.movie) this.movie.fullyStale = true;
		if (this.tv) this.tv.fullyStale = true;
	}

	invalidateMovie(movieId: string): void {
		if (this.movie) this.movie.staleIds.add(movieId);
	}

	invalidateSeries(seriesId: string): void {
		if (this.tv) this.tv.staleIds.add(seriesId);
	}

	/**
	 * Patch a partially-stale cache: remove stale items, merge fresh ones, re-run
	 * collision detection over the combined willChange set.
	 */
	applyPatch(
		mediaType: 'movie' | 'tv',
		staleIds: Set<string>,
		freshResult: RenamePreviewResult
	): void {
		const c = mediaType === 'movie' ? this.movie : this.tv;
		if (!c) return;

		const notStale = (item: RenamePreviewItem) => !staleIds.has(item.mediaId);

		// Move previous collisions back into willChange before merging so
		// collision detection sees the full combined set.
		const prevWillChange: RenamePreviewItem[] = [
			...c.result.willChange.filter(notStale),
			...c.result.collisions.filter(notStale).map((item) => ({
				...item,
				status: 'will_change' as const,
				collisionsWith: undefined
			})),
			...freshResult.willChange
		];

		c.result.willChange = prevWillChange;
		c.result.alreadyCorrect = [
			...c.result.alreadyCorrect.filter(notStale),
			...freshResult.alreadyCorrect
		];
		c.result.errors = [...c.result.errors.filter(notStale), ...freshResult.errors];
		c.result.collisions = [];

		this.detectCollisions(c.result);

		c.result.totalWillChange = c.result.willChange.length;
		c.result.totalAlreadyCorrect = c.result.alreadyCorrect.length;
		c.result.totalCollisions = c.result.collisions.length;
		c.result.totalErrors = c.result.errors.length;
		c.result.totalFiles =
			c.result.totalWillChange +
			c.result.totalAlreadyCorrect +
			c.result.totalCollisions +
			c.result.totalErrors;

		c.staleIds.clear();
	}

	private detectCollisions(result: RenamePreviewResult): void {
		const pathMap = new Map<string, RenamePreviewItem[]>();
		for (const item of result.willChange) {
			const existing = pathMap.get(item.newFullPath) || [];
			existing.push(item);
			pathMap.set(item.newFullPath, existing);
		}
		for (const items of pathMap.values()) {
			if (items.length > 1) {
				for (const item of items) {
					item.status = 'collision';
					item.collisionsWith = items.filter((i) => i.fileId !== item.fileId).map((i) => i.fileId);
					const idx = result.willChange.indexOf(item);
					if (idx !== -1) {
						result.willChange.splice(idx, 1);
						result.collisions.push(item);
					}
				}
			}
		}
	}
}

export const renamePreviewCache = new RenamePreviewCacheStore();
