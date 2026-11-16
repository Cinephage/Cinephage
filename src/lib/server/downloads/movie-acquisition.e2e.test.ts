/**
 * End-to-end acquisition path for a movie: indexer results -> deduplication ->
 * scoring/ranking -> the real grab decision pipeline -> accepted grab.
 *
 * These cases exist because the acquisition chain has twice failed only in
 * state that unit tests did not model:
 *  - indexers that bracket the resolution ("Movie (2005) [1080p] [BluRay]")
 *    and report no infoHash (Prowlarr proxies, YTS, LimeTorrents), where
 *    deduplication merged the 1080p and 2160p copies of one film and only the
 *    4K survived - a 1080p target then saw nothing but 4K candidates;
 *  - a movie the user re-adds or re-downloads, where imported history made
 *    every release it had already used ungrabbable.
 *
 * The loop below mirrors MonitoringSearchService.searchAndGrabMovie: ranked
 * releases in order, first accepted grab wins.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, destroyTestDb, type TestDatabase } from '../../../test/db-helper.js';
import {
	downloadClients,
	downloadHistory,
	languageProfiles,
	movies
} from '#lib/server/db/schema.js';
import type { ReleaseResult } from '#lib/server/indexers/types/index.js';

const testDb: TestDatabase = createTestDb();

vi.mock('#lib/server/db/index.js', () => ({
	get db() {
		return testDb.db;
	},
	get sqlite() {
		return testDb.sqlite;
	},
	initializeDatabase: vi.fn().mockResolvedValue(undefined)
}));

// Keep the real pipeline; pin scoring to Balanced's real resolution weights so
// "4K outranks 1080p" is the ordering the test reasons about.
vi.mock('#lib/server/quality/QualityFilter.js', () => ({
	qualityFilter: {
		getProfile: vi.fn().mockResolvedValue(null),
		getDefaultScoringProfile: vi.fn().mockResolvedValue({
			id: 'balanced',
			name: 'Balanced',
			minScore: 0,
			upgradesAllowed: true,
			formatScores: {},
			allowedProtocols: ['torrent', 'usenet', 'streaming']
		}),
		calculateEnhancedScore: vi.fn((parsed: { resolution?: string }) => ({
			scoringResult: {
				releaseName: '',
				profile: 'Balanced',
				resolution: parsed.resolution,
				totalScore: parsed.resolution === '2160p' ? 250 : parsed.resolution === '1080p' ? 200 : 100,
				matchedFormats: [],
				breakdown: {},
				meetsMinimum: true,
				isBanned: false,
				bannedReasons: [],
				sizeRejected: false,
				sizeRejectionReason: undefined,
				protocolRejected: false,
				protocolRejectionReason: undefined
			}
		}))
	}
}));

vi.mock('./handlers/TorrentHandler.js', () => ({
	TorrentHandler: class {
		async handle(
			request: { release: { title: string; infoHash?: string } },
			resolved: { movieId?: string }
		) {
			const { db } = await import('#lib/server/db/index.js');
			const { downloadQueue: queue } = await import('#lib/server/db/schema.js');
			const { ReleaseParser } = await import('#lib/server/indexers/parser/ReleaseParser.js');
			const parsed = new ReleaseParser().parse(request.release.title);
			const id = `queue-${resolved.movieId}-${parsed.resolution}`;
			await db.insert(queue).values({
				id,
				downloadClientId: 'client-1',
				downloadId: `hash-${id}`,
				infoHash: request.release.infoHash,
				title: request.release.title,
				movieId: resolved.movieId,
				status: 'queued',
				protocol: 'torrent',
				quality: { resolution: parsed.resolution }
			});
			return {
				success: true,
				queueId: id,
				hash: `hash-${id}`,
				clientId: 'client-1',
				clientName: 'qBittorrent',
				wasDuplicate: false
			};
		}
	}
}));

const { enrichMock } = vi.hoisted(() => ({ enrichMock: vi.fn() }));

vi.mock('../quality', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return { ...actual, releaseEnricher: { enrich: enrichMock } };
});

vi.mock('#lib/server/blocklist/BlocklistService.js', () => ({
	blocklistService: {
		getBlockedIdentifiers: vi
			.fn()
			.mockResolvedValue({ blockedHashes: new Set<string>(), blockedTitles: new Set<string>() }),
		isBlocklisted: vi.fn().mockResolvedValue({ blocked: false })
	}
}));

vi.mock('#lib/server/tmdb.js', () => ({
	tmdb: {
		getMovieExternalIds: vi.fn(),
		getTvExternalIds: vi.fn(),
		getTVShow: vi.fn(),
		getSeason: vi.fn()
	}
}));

const { SearchOrchestrator } = await import('#lib/server/indexers/search/SearchOrchestrator.js');
const { grabService } = await import('./GrabService.js');
const { createMockIndexer } = await import('../../../test/fixtures/indexers.js');

const CAPABILITIES = {
	search: { available: true, supportedParams: ['q'] },
	tvSearch: { available: false, supportedParams: [] },
	movieSearch: { available: true, supportedParams: ['q', 'year'] },
	categories: new Map([[2000, 'Movies']]),
	supportsPagination: false,
	supportsInfoHash: false,
	limitMax: 100,
	limitDefault: 50,
	searchFormats: { episode: ['standard'] }
};

/** A Prowlarr/YTS-shaped result: resolution inside brackets, no infoHash. */
function bracketed(title: string, size: number): ReleaseResult {
	return {
		guid: title,
		title,
		downloadUrl: 'https://tracker.example/download/1',
		publishDate: new Date('2026-01-01T00:00:00Z'),
		size,
		indexerId: 'idx-1',
		indexerName: 'Prowlarr',
		protocol: 'torrent',
		categories: [2000]
	};
}

function buildIndexer(releases: ReleaseResult[]) {
	return createMockIndexer({
		id: 'idx-1',
		name: 'Prowlarr',
		protocol: 'torrent',
		capabilities: CAPABILITIES as unknown as Record<string, unknown>,
		search: vi.fn(async () => releases)
	});
}

function resetDb() {
	testDb.sqlite.exec(`
		DELETE FROM acquisition_reservations;
		DELETE FROM acquisition_intents;
		DELETE FROM download_queue;
		DELETE FROM download_history;
		DELETE FROM movie_files;
		DELETE FROM movies;
		DELETE FROM download_clients;
	`);
	testDb.db
		.insert(downloadClients)
		.values({
			id: 'client-1',
			name: 'qBittorrent',
			implementation: 'qbittorrent',
			host: 'localhost',
			port: 8080
		})
		.run();
}

function seedMovie(id: string, tmdbId: number, desired: string[] | null) {
	testDb.db
		.insert(movies)
		.values({
			id,
			tmdbId,
			title: 'Harry Potter and the Goblet of Fire',
			path: 'Harry Potter (2005)',
			desiredQualities: desired as never
		})
		.run();
}

/** The production loop: ranked releases in order, first accepted grab wins. */
async function runAcquisitionLoop(
	releases: Array<{ title: string; infoHash?: string; size?: number }>,
	movieId: string
) {
	let lastResult: Awaited<ReturnType<typeof grabService.grab>> | undefined;
	for (const release of releases) {
		const result = await grabService.grab({
			release: {
				title: release.title,
				infoHash: release.infoHash,
				protocol: 'torrent',
				size: release.size ?? 4_000_000_000
			},
			target: { type: 'movie', movieId },
			options: {
				force: false,
				skipBlocklist: false,
				allowSidegrade: false,
				isAutomatic: true,
				skipDelay: true
			}
		});
		lastResult = result;
		if (result.success) return { grabbed: release, result };
	}
	return { grabbed: undefined, result: lastResult };
}

describe('movie acquisition end to end', () => {
	afterAll(() => destroyTestDb(testDb));

	beforeEach(() => {
		vi.clearAllMocks();
		resetDb();
		// Scoring order for the enhanced path: 4K above 1080p, as Balanced ranks them.
		enrichMock.mockImplementation(async (input: ReleaseResult[]) => ({
			releases: input
				.map((release) => {
					const resolution = release.title.includes('2160p') ? '2160p' : '1080p';
					return {
						...release,
						parsed: { resolution },
						totalScore: resolution === '2160p' ? 250 : 200,
						scoreComponents: { totalScore: resolution === '2160p' ? 250 : 200 },
						rejected: false,
						rejections: []
					};
				})
				.sort((a, b) => b.totalScore - a.totalScore)
		}));
	});

	it('grabs the 1080p tier when bracketed titles carry no infoHash', async () => {
		seedMovie('movie-1', 674, ['1080p']);
		const indexer = buildIndexer([
			bracketed('Harry Potter and the Goblet of Fire (2005) [1080p] [BluRay] [5.1]', 3_000_000_000),
			bracketed('Harry Potter and the Goblet of Fire (2005) [2160p] [BluRay] [5.1]', 12_000_000_000)
		]);

		const search = await new SearchOrchestrator().searchEnhanced([indexer], {
			searchType: 'movie',
			query: 'Harry Potter and the Goblet of Fire',
			year: 2005,
			tmdbId: 674
		});

		// Both tiers must survive deduplication, in ranked order.
		expect(new Set(search.releases.map((release) => release.parsed.resolution))).toEqual(
			new Set(['2160p', '1080p'])
		);

		const { grabbed } = await runAcquisitionLoop(search.releases, 'movie-1');
		expect(grabbed?.title).toContain('1080p');
	});

	it('takes the 4K tier when the movie declares no desired quality', async () => {
		seedMovie('movie-2', 675, null);
		const indexer = buildIndexer([
			bracketed('Harry Potter and the Goblet of Fire (2005) [1080p] [BluRay] [5.1]', 3_000_000_000),
			bracketed('Harry Potter and the Goblet of Fire (2005) [2160p] [BluRay] [5.1]', 12_000_000_000)
		]);

		const search = await new SearchOrchestrator().searchEnhanced([indexer], {
			searchType: 'movie',
			query: 'Harry Potter and the Goblet of Fire',
			year: 2005,
			tmdbId: 675
		});
		const { grabbed } = await runAcquisitionLoop(search.releases, 'movie-2');
		expect(grabbed?.title).toContain('2160p');
	});

	it('re-grabs a release imported before, once its file is gone', async () => {
		seedMovie('movie-1', 674, ['1080p']);
		const infoHash = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd';
		testDb.db
			.insert(downloadHistory)
			.values({
				title: 'Harry.Potter.and.the.Goblet.of.Fire.2005.1080p.BluRay-GROUP',
				infoHash,
				downloadId: infoHash,
				status: 'imported',
				movieId: 'movie-1',
				protocol: 'torrent'
			})
			.run();

		const { grabbed, result } = await runAcquisitionLoop(
			[
				{
					title: 'Harry.Potter.and.the.Goblet.of.Fire.2005.1080p.BluRay-GROUP',
					infoHash,
					size: 3_000_000_000
				}
			],
			'movie-1'
		);

		expect(result?.success).toBe(true);
		expect(grabbed?.infoHash).toBe(infoHash);
	});

	it('prefers the Spanish dub over an English-subtitled release for a Chinese film', async () => {
		seedMovie('movie-1', 674, ['1080p']);
		testDb.db
			.insert(languageProfiles)
			.values({
				id: 'p-eng-spa',
				name: 'Eng+Spa',
				audio: { preferOriginal: true, languages: ['en', 'es'], mode: 'prefer' },
				subtitles: []
			})
			.run();
		testDb.sqlite.exec(
			`UPDATE movies SET original_language = 'zh', language_profile_id = 'p-eng-spa' WHERE id = 'movie-1';`
		);

		const indexer = buildIndexer([
			bracketed(
				'Harry Potter and the Goblet of Fire (2005) [1080p] [BluRay] Dub + Sub Eng, Fra',
				3_000_000_000
			),
			bracketed(
				'Harry Potter and the Goblet of Fire (2005) [1080p] [BluRay] Spanish DDP5.1',
				3_100_000_000
			)
		]);

		const search = await new SearchOrchestrator().searchEnhanced(
			[indexer],
			{
				searchType: 'movie',
				query: 'Harry Potter and the Goblet of Fire',
				year: 2005,
				tmdbId: 674,
				audioPreference: {
					preferOriginal: true,
					languages: ['en', 'es'],
					originalLanguage: 'zh',
					mode: 'prefer'
				}
			},
			{ searchSource: 'automatic' }
		);

		const { grabbed } = await runAcquisitionLoop(search.releases, 'movie-1');
		expect(grabbed?.title).toContain('Spanish');
	});

	it('refuses a hash that was imported for a different movie', async () => {
		seedMovie('movie-1', 674, ['1080p']);
		seedMovie('movie-2', 675, ['1080p']);
		const infoHash = 'bb22cc33dd44ee55ff6677889900aabbccddee01';
		testDb.db
			.insert(downloadHistory)
			.values({
				title: 'Some.Other.Movie.2005.1080p.BluRay-GROUP',
				infoHash,
				downloadId: infoHash,
				status: 'imported',
				movieId: 'movie-2',
				protocol: 'torrent'
			})
			.run();

		const { grabbed, result } = await runAcquisitionLoop(
			[
				{
					title: 'Harry.Potter.and.the.Goblet.of.Fire.2005.1080p.BluRay-GROUP',
					infoHash,
					size: 3_000_000_000
				}
			],
			'movie-1'
		);

		expect(grabbed).toBeUndefined();
		expect(result?.success).toBe(false);
		expect(result?.decision.rejectionType).toBe('duplicate_hash');
	});
});
