import { describe, it, expect, beforeEach } from 'vitest';
import { renamePreviewCache } from './RenamePreviewCache.js';
import { libraryMediaEvents } from '#lib/server/library/LibraryMediaEvents.js';
import type { RenamePreviewResult } from '#lib/library/naming/types.js';

function makeResult(overrides: Partial<RenamePreviewResult> = {}): RenamePreviewResult {
	return {
		willChange: [],
		alreadyCorrect: [],
		collisions: [],
		errors: [],
		totalFiles: 0,
		totalWillChange: 0,
		totalAlreadyCorrect: 0,
		totalCollisions: 0,
		totalErrors: 0,
		...overrides
	};
}

describe('RenamePreviewCache', () => {
	beforeEach(() => {
		renamePreviewCache.invalidateAll();
		renamePreviewCache.set('movie', makeResult(), null);
		renamePreviewCache.set('tv', makeResult(), null);
	});

	it('stores and reports fingerprints alongside results', () => {
		expect(renamePreviewCache.getStoredFingerprint('movie')).toBeNull();

		renamePreviewCache.set('movie', makeResult(), 'fp-1');
		expect(renamePreviewCache.getStoredFingerprint('movie')).toBe('fp-1');
		expect(renamePreviewCache.getStoredFingerprint('tv')).toBeNull();

		renamePreviewCache.set('movie', makeResult(), 'fp-2');
		expect(renamePreviewCache.getStoredFingerprint('movie')).toBe('fp-2');
	});

	it('marks per-entity staleness for movie:updated events', () => {
		expect(renamePreviewCache.isFresh('movie')).toBe(true);

		libraryMediaEvents.emitMovieUpdated('movie-1');

		expect(renamePreviewCache.isFresh('movie')).toBe(false);
		expect(renamePreviewCache.isPartiallyCached('movie')).toBe(true);
		expect(renamePreviewCache.getStaleIds('movie').has('movie-1')).toBe(true);
		// tv cache untouched
		expect(renamePreviewCache.isFresh('tv')).toBe(true);
	});

	it('fully invalidates on library:data-changed without an entity scope', () => {
		renamePreviewCache.set('movie', makeResult(), 'fp-1');

		libraryMediaEvents.emitLibraryDataChanged({ source: 'library', reason: 'bulk-movies-added' });

		expect(renamePreviewCache.isFresh('movie')).toBe(false);
		expect(renamePreviewCache.isPartiallyCached('movie')).toBe(false);
		expect(renamePreviewCache.getStoredFingerprint('movie')).toBe('fp-1');
	});

	it('marks per-entity staleness on library:data-changed with an entity scope', () => {
		libraryMediaEvents.emitLibraryDataChanged({
			source: 'series',
			reason: 'series-edited',
			entityId: 'series-7'
		});

		expect(renamePreviewCache.isPartiallyCached('tv')).toBe(true);
		expect(renamePreviewCache.getStaleIds('tv').has('series-7')).toBe(true);
	});

	it('applyPatch clears stale ids and merges fresh results', () => {
		libraryMediaEvents.emitMovieUpdated('movie-1');

		const fresh = makeResult({
			willChange: [],
			alreadyCorrect: [],
			totalFiles: 1,
			totalAlreadyCorrect: 1
		});
		fresh.alreadyCorrect = [
			{
				fileId: 'file-1',
				mediaType: 'movie',
				mediaId: 'movie-1',
				mediaTitle: 'Movie',
				currentParentPath: '/a',
				currentRelativePath: 'old.mkv',
				currentFullPath: '/a/old.mkv',
				newParentPath: '/b',
				newRelativePath: 'new.mkv',
				newFullPath: '/b/new.mkv',
				status: 'already_correct'
			}
		];
		renamePreviewCache.applyPatch('movie', renamePreviewCache.getStaleIds('movie'), fresh);

		expect(renamePreviewCache.isFresh('movie')).toBe(true);
		expect(renamePreviewCache.get('movie')?.totalAlreadyCorrect).toBe(1);
	});
});
