import { describe, it, expect } from 'vitest';
import {
	isRuTrackerIndexerName,
	isRuTrackerHost,
	isRuTrackerRelease,
	orderTitlesForCyrillicTracker,
	limitedRuTrackerSeasonTitles,
	prefersNativeCyrillicTitles,
	RUSSIAN_TRACKER_NAMES,
	RUTRACKER_AUTOMATIC_MAX_TITLES,
	RUTRACKER_AUTOMATIC_SEASON_CACHE_TTL_MS
} from './russian-trackers';
import type { IIndexer } from '../types';

function makeIndexer(overrides: Partial<Pick<IIndexer, 'name' | 'baseUrl'>> = {}): IIndexer {
	return {
		id: 'test-id',
		name: 'test-indexer',
		definitionId: 'test-def',
		protocol: 'torrent',
		accessType: 'private',
		capabilities: {
			search: { available: true, supportedParams: ['q'] },
			categories: new Map(),
			supportsPagination: false,
			supportsInfoHash: false,
			limitMax: 100,
			limitDefault: 100
		},
		baseUrl: 'https://example.com',
		enableAutomaticSearch: true,
		enableInteractiveSearch: true,
		search: async () => [],
		...overrides
	} as unknown as IIndexer;
}

describe('russian-trackers', () => {
	describe('RUSSIAN_TRACKER_NAMES', () => {
		it('should contain known Russian tracker names', () => {
			expect(RUSSIAN_TRACKER_NAMES).toContain('rutracker');
			expect(RUSSIAN_TRACKER_NAMES).toContain('kinozal');
			expect(RUSSIAN_TRACKER_NAMES).toContain('rutor');
			expect(RUSSIAN_TRACKER_NAMES).toContain('nnmclub');
			expect(RUSSIAN_TRACKER_NAMES).toContain('noname club');
		});
	});

	describe('RUTRACKER_AUTOMATIC_MAX_TITLES', () => {
		it('should be 2', () => {
			expect(RUTRACKER_AUTOMATIC_MAX_TITLES).toBe(2);
		});
	});

	describe('RUTRACKER_AUTOMATIC_SEASON_CACHE_TTL_MS', () => {
		it('should be 3 minutes in milliseconds', () => {
			expect(RUTRACKER_AUTOMATIC_SEASON_CACHE_TTL_MS).toBe(3 * 60_000);
		});
	});

	describe('isRuTrackerIndexerName', () => {
		it('should return false for undefined', () => {
			expect(isRuTrackerIndexerName(undefined)).toBe(false);
		});

		it('should return false for non-Russian tracker names', () => {
			expect(isRuTrackerIndexerName('anidex')).toBe(false);
			expect(isRuTrackerIndexerName('torrentday')).toBe(false);
		});

		it('should return true for rutracker in name', () => {
			expect(isRuTrackerIndexerName('ruTracker')).toBe(true);
			expect(isRuTrackerIndexerName('My RuTracker Mirror')).toBe(true);
		});

		it('should return true for kinozal in name', () => {
			expect(isRuTrackerIndexerName('kinozal')).toBe(true);
			expect(isRuTrackerIndexerName('Kinozal HD')).toBe(true);
		});

		it('should be case-insensitive', () => {
			expect(isRuTrackerIndexerName('RUTRACKER')).toBe(true);
			expect(isRuTrackerIndexerName('KINOZAL')).toBe(true);
		});
	});

	describe('isRuTrackerHost', () => {
		it('should return false for undefined', () => {
			expect(isRuTrackerHost(undefined)).toBe(false);
		});

		it('should return false for non-Russian hosts', () => {
			expect(isRuTrackerHost('https://example.com')).toBe(false);
			expect(isRuTrackerHost('https://torrentday.com')).toBe(false);
		});

		it('should return true for rutracker domain in URL', () => {
			expect(isRuTrackerHost('https://rutracker.org/forum/viewforum.php')).toBe(true);
		});

		it('should return true for kinozal domain in URL', () => {
			expect(isRuTrackerHost('https://kinozal.tv/browse.php')).toBe(true);
		});

		it('should handle invalid URLs gracefully', () => {
			expect(isRuTrackerHost('not-a-valid-url-but-has-rutracker.')).toBe(true);
			expect(isRuTrackerHost('not-a-valid-url')).toBe(false);
		});
	});

	describe('isRuTrackerRelease', () => {
		it('should delegate to isRuTrackerIndexerName', () => {
			expect(isRuTrackerRelease('rutracker')).toBe(true);
			expect(isRuTrackerRelease('anidex')).toBe(false);
			expect(isRuTrackerRelease(undefined)).toBe(false);
		});
	});

	describe('prefersNativeCyrillicTitles', () => {
		it('should return true for rutracker indexer by name', () => {
			const indexer = makeIndexer({
				name: 'RuTracker',
				baseUrl: 'https://rutracker.org'
			});
			expect(prefersNativeCyrillicTitles(indexer)).toBe(true);
		});

		it('should return true for NoNaMe Club by display name', () => {
			const indexer = makeIndexer({
				name: 'NoNaMe Club',
				baseUrl: 'https://nnmclub.to'
			});
			expect(prefersNativeCyrillicTitles(indexer)).toBe(true);
		});

		it('should return true for .ru domain', () => {
			const indexer = makeIndexer({
				name: 'some-indexer',
				baseUrl: 'https://example.ru'
			});
			expect(prefersNativeCyrillicTitles(indexer)).toBe(true);
		});

		it('should return true for subdomain of .ru', () => {
			const indexer = makeIndexer({
				name: 'some-indexer',
				baseUrl: 'https://tor.example.ru/api'
			});
			expect(prefersNativeCyrillicTitles(indexer)).toBe(true);
		});

		it('should return false for non-Russian indexer', () => {
			const indexer = makeIndexer({
				name: 'Anidex',
				baseUrl: 'https://anidex.info'
			});
			expect(prefersNativeCyrillicTitles(indexer)).toBe(false);
		});

		it('should handle name being empty gracefully', () => {
			const indexer = makeIndexer({
				name: '',
				baseUrl: 'https://example.com'
			});
			expect(prefersNativeCyrillicTitles(indexer)).toBe(false);
		});

		it('should handle invalid baseUrl gracefully', () => {
			const indexer = makeIndexer({
				name: 'test',
				baseUrl: 'not-a-url'
			});
			expect(prefersNativeCyrillicTitles(indexer)).toBe(false);
		});
	});
});

import { ReleaseDeduplicator } from './ReleaseDeduplicator.js';

describe('ReleaseDeduplicator title-key year handling (audit)', () => {
	it('does not merge different-year releases that lack infoHashes', () => {
		const dedup = new ReleaseDeduplicator();
		const mk = (year: string) =>
			({
				guid: `no-${year}`,
				title: `The Lion King (${year}) 1080p BluRay x264`,
				downloadUrl: 'https://example.test/dl',
				publishDate: new Date(),
				size: 1_000_000,
				indexerId: 'idx',
				indexerName: 'Idx',
				protocol: 'torrent',
				categories: []
			}) as never;
		const { releases } = dedup.deduplicate([mk('1994'), mk('2019')]);
		expect(releases).toHaveLength(2);
	});

	describe('orderTitlesForCyrillicTracker', () => {
		it('puts Cyrillic titles first and keeps the Latin ones', () => {
			// RuTracker topics are named "Русское название / English Title", so the
			// original title must survive as a second query, not be discarded.
			expect(orderTitlesForCyrillicTracker(['The 10th Kingdom', 'Десятое королевство'])).toEqual([
				'Десятое королевство',
				'The 10th Kingdom'
			]);
		});

		it('keeps every Latin title when nothing is Cyrillic', () => {
			// There is no Cyrillic title to fall back from, so the single-slot rule
			// would only discard alternates that are legitimate queries.
			expect(orderTitlesForCyrillicTracker(['Dune', 'Dune: Part Two'])).toEqual([
				'Dune',
				'Dune: Part Two'
			]);
		});

		it('keeps exactly one Latin fallback alongside Cyrillic titles', () => {
			expect(
				orderTitlesForCyrillicTracker(['Десятое королевство', 'The 10th Kingdom', 'Dune'])
			).toEqual(['Десятое королевство', 'The 10th Kingdom']);
		});
	});

	describe('limitedRuTrackerSeasonTitles', () => {
		it('reserves the last slot for the Latin fallback', () => {
			expect(limitedRuTrackerSeasonTitles(['Квест Вижн', 'Квест', 'VisionQuest'])).toEqual([
				'Квест Вижн',
				'VisionQuest'
			]);
		});

		it('returns a list that already fits untouched', () => {
			expect(limitedRuTrackerSeasonTitles(['Квест Вижн', 'VisionQuest'])).toEqual([
				'Квест Вижн',
				'VisionQuest'
			]);
		});

		it('slices a Cyrillic-only list to the budget', () => {
			expect(limitedRuTrackerSeasonTitles(['Квест Вижн', 'Квест', 'Вижн'])).toEqual([
				'Квест Вижн',
				'Квест'
			]);
		});

		it('never exceeds a budget of one', () => {
			expect(limitedRuTrackerSeasonTitles(['Квест', 'VisionQuest'], 1)).toEqual(['Квест']);
		});
	});
});
