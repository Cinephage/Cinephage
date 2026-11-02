import { describe, it, expect } from 'vitest';
import { buildMovieNfo, buildSeasonNfo, buildEpisodeNfo, nfoPathFor } from './NfoGenerator.js';
import type { movies, series, seasons, episodes } from '#lib/server/db/schema.js';

type Movie = typeof movies.$inferSelect;
type Series = typeof series.$inferSelect;
type Season = typeof seasons.$inferSelect;
type Episode = typeof episodes.$inferSelect;

function makeMovie(overrides: Partial<Movie> = {}): Movie {
	return {
		id: 'movie-1',
		tmdbId: 559,
		imdbId: 'tt0413300',
		title: 'Spider-Man 3',
		originalTitle: 'Spider-Man 3',
		year: 2007,
		overview: 'A web-slinger story with "quotes" & ampersands.',
		posterPath: null,
		backdropPath: null,
		runtime: 139,
		genres: ['Action', 'Adventure'],
		providerRefs: null,
		path: 'Spider-Man 3 (2007)',
		libraryId: null,
		rootFolderId: null,
		scoringProfileId: null,
		desiredQualities: null,
		languageProfileId: null,
		monitored: true,
		minimumAvailability: 'released',
		added: '2026-09-12T00:00:00.000Z',
		hasFile: true,
		wantsSubtitles: true,
		lastSearchTime: null,
		failedSubtitleAttempts: 0,
		firstSubtitleSearchAt: null,
		tmdbCollectionId: null,
		collectionName: null,
		releaseDate: '2007-05-01',
		downloadReleaseDate: null,
		downloadReleaseType: null,
		digitalReleaseDate: null,
		physicalReleaseDate: null,
		availabilityDelay: 0,
		adult: false,
		adultSource: null,
		adultConfidence: null,
		delayProfileId: null,
		metadataLanguage: null,
		preferOriginalTitle: false,
		...overrides
	} as Movie;
}

describe('NfoGenerator', () => {
	describe('buildMovieNfo', () => {
		it('includes the streamdetails block that fixes the real Jellyfin problem', () => {
			const xml = buildMovieNfo(makeMovie(), {
				mediaInfo: { width: 3840, height: 2160, runtime: 8340, videoCodec: 'hevc' },
				quality: { codec: 'x265' }
			});

			expect(xml).toContain('<width>3840</width>');
			expect(xml).toContain('<height>2160</height>');
			expect(xml).toContain('<durationinseconds>8340</durationinseconds>');
			expect(xml).toContain('<codec>hevc</codec>');
		});

		it('escapes descriptive text so quotes/ampersands cannot break the XML', () => {
			const xml = buildMovieNfo(makeMovie(), null);

			expect(xml).toContain(
				'<plot>A web-slinger story with &quot;quotes&quot; &amp; ampersands.</plot>'
			);
			// The raw, unescaped characters must not appear anywhere.
			expect(xml).not.toContain('"quotes"');
			expect(xml).not.toContain('quotes" &');
		});

		it('writes uniqueid tags in the exact format Jellyfin parses (type attribute)', () => {
			const xml = buildMovieNfo(makeMovie(), null);

			expect(xml).toContain('<uniqueid type="tmdb" default="true">559</uniqueid>');
			expect(xml).toContain('<uniqueid type="imdb">tt0413300</uniqueid>');
		});

		it('omits fileinfo entirely when there is no usable media info', () => {
			const xml = buildMovieNfo(makeMovie(), { mediaInfo: null, quality: null });

			expect(xml).not.toContain('<fileinfo>');
		});

		it('omits genre/plot/premiered tags gracefully when data is missing', () => {
			const xml = buildMovieNfo(
				makeMovie({ overview: null, genres: null, releaseDate: null }),
				null
			);

			expect(xml).not.toContain('<plot>');
			expect(xml).not.toContain('<genre>');
			expect(xml).not.toContain('<premiered>');
		});

		it('starts with a UTF-8 BOM, required for Jellyfin to apply fileinfo/streamdetails', () => {
			const xml = buildMovieNfo(makeMovie(), null);

			expect(xml.charCodeAt(0)).toBe(0xfeff);
		});

		it('includes a <set> tag when the movie belongs to a collection', () => {
			const xml = buildMovieNfo(makeMovie({ collectionName: 'The Fast Saga' }), null);

			expect(xml).toContain('<set>');
			expect(xml).toContain('<name>The Fast Saga</name>');
		});

		it('omits <set> when the movie has no collection', () => {
			const xml = buildMovieNfo(makeMovie({ collectionName: null }), null);

			expect(xml).not.toContain('<set>');
		});

		it('includes an <art> block only when artwork is enabled', () => {
			const withArt = buildMovieNfo(makeMovie(), null, true);
			const withoutArt = buildMovieNfo(makeMovie(), null, false);

			expect(withArt).toContain('<art>');
			expect(withArt).toContain('<poster>poster.jpg</poster>');
			expect(withArt).toContain('<fanart>fanart.jpg</fanart>');
			expect(withoutArt).not.toContain('<art>');
		});
	});

	describe('buildEpisodeNfo', () => {
		const seriesRow = {
			id: 'series-1',
			title: 'The Boys'
		} as Series;

		function makeEpisode(overrides: Partial<Episode> = {}): Episode {
			return {
				id: 'ep-1',
				seriesId: 'series-1',
				seasonId: null,
				tmdbId: 12345,
				tvdbId: null,
				seasonNumber: 1,
				episodeNumber: 1,
				absoluteEpisodeNumber: null,
				title: 'The Name of the Game',
				overview: 'Pilot episode.',
				airDate: '2019-07-26',
				runtime: 60,
				monitored: true,
				hasFile: true,
				wantsSubtitlesOverride: null,
				lastSearchTime: null,
				failedSubtitleAttempts: 0,
				firstSubtitleSearchAt: null,
				...overrides
			} as Episode;
		}

		it('writes one <episodedetails> block per episode for a single-episode file', () => {
			const xml = buildEpisodeNfo(seriesRow, [makeEpisode()], null);
			const matches = xml.match(/<episodedetails>/g) ?? [];

			expect(matches).toHaveLength(1);
			expect(xml).toContain('<showtitle>The Boys</showtitle>');
			expect(xml).toContain('<season>1</season>');
			expect(xml).toContain('<episode>1</episode>');
		});

		it('writes multiple concatenated <episodedetails> blocks for a multi-episode file', () => {
			const xml = buildEpisodeNfo(
				seriesRow,
				[
					makeEpisode({ id: 'ep-1', episodeNumber: 1 }),
					makeEpisode({ id: 'ep-2', episodeNumber: 2 })
				],
				{ mediaInfo: { width: 1920, height: 1080 }, quality: null }
			);
			const matches = xml.match(/<episodedetails>/g) ?? [];

			expect(matches).toHaveLength(2);
			expect(xml).toContain('<episode>1</episode>');
			expect(xml).toContain('<episode>2</episode>');
			// streamdetails applies to the shared file, so it appears in both blocks
			expect((xml.match(/<width>1920<\/width>/g) ?? []).length).toBe(2);
		});
	});

	describe('buildSeasonNfo', () => {
		function makeSeason(overrides: Partial<Season> = {}): Season {
			return {
				id: 'season-1',
				seriesId: 'series-1',
				seasonNumber: 1,
				monitored: true,
				name: 'Season 1',
				overview: 'The boys get started.',
				posterPath: '/poster.jpg',
				airDate: '2019-07-26',
				episodeCount: 8,
				episodeFileCount: 8,
				...overrides
			} as Season;
		}

		it('writes the real Kodi/Jellyfin <season> root element and tags', () => {
			const xml = buildSeasonNfo(makeSeason());

			expect(xml).toContain('<season>');
			expect(xml).toContain('<title>Season 1</title>');
			expect(xml).toContain('<seasonnumber>1</seasonnumber>');
			expect(xml).toContain('<plot>The boys get started.</plot>');
			expect(xml).toContain('<premiered>2019-07-26</premiered>');
		});

		it('omits plot/premiered gracefully when data is missing', () => {
			const xml = buildSeasonNfo(makeSeason({ overview: null, airDate: null }));

			expect(xml).not.toContain('<plot>');
			expect(xml).not.toContain('<premiered>');
		});
	});

	describe('nfoPathFor', () => {
		it('replaces the extension with .nfo', () => {
			expect(nfoPathFor('/movies/Movie (2024)/Movie (2024) [x265].strm')).toBe(
				'/movies/Movie (2024)/Movie (2024) [x265].nfo'
			);
		});

		it('handles filenames with dots in the directory but not the base name', () => {
			expect(nfoPathFor('/movies/Movie Vol. 2/file.mkv')).toBe('/movies/Movie Vol. 2/file.nfo');
		});
	});
});
