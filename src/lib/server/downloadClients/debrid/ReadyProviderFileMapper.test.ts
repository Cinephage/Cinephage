import { describe, expect, it, vi } from 'vitest';
import { ReadyProviderFileMapper } from './ReadyProviderFileMapper';
import type { ProviderFile, ProviderItem } from './debrid-adapter';

const GIB = 1024 ** 3;

function file(id: string, path: string, overrides: Partial<ProviderFile> = {}): ProviderFile {
	return {
		providerFileId: id,
		path,
		name: path.split('/').at(-1) ?? path,
		sizeBytes: GIB,
		selected: true,
		...overrides
	};
}

function item(files: ProviderFile[]): ProviderItem {
	return {
		providerItemId: 'provider-item',
		providerState: 'downloaded',
		readiness: 'ready',
		files
	};
}

const movie = {
	queueItem: { id: 'queue', title: 'Movie 2026 1080p', movieId: 'movie', protocol: 'debrid' },
	media: {
		type: 'movie' as const,
		movie: { id: 'movie', title: 'Movie', year: 2026, tmdbId: 42, path: 'Movie (2026)' }
	},
	library: { rootPath: '/library/movies' }
};

const episodes = [
	{ id: 'e1', seasonNumber: 1, episodeNumber: 1, title: 'Pilot' },
	{ id: 'e2', seasonNumber: 1, episodeNumber: 2, title: 'Second' },
	{ id: 'e3', seasonNumber: 1, episodeNumber: 3, title: 'Third' }
];

function series(episodeIds = ['e1', 'e2'], title = 'Show S01E01-E02 1080p') {
	return {
		queueItem: {
			id: 'queue',
			title,
			seriesId: 'show',
			episodeIds,
			seasonNumber: 1,
			protocol: 'debrid'
		},
		media: {
			type: 'series' as const,
			series: {
				id: 'show',
				title: 'Show',
				year: 2026,
				path: 'Show',
				seriesType: 'standard',
				seasonFolder: true
			},
			episodes
		},
		library: { rootPath: '/library/tv' }
	};
}

function mapper() {
	return new ReadyProviderFileMapper({
		naming: {
			generateMovieFileName: vi.fn(() => 'Movie (2026) Bluray-1080p.mkv'),
			generateEpisodeFileName: vi.fn((info: { episodeNumbers?: number[] }) => {
				const numbers = info.episodeNumbers ?? [];
				return `Show - S01${numbers.map((number) => `E${String(number).padStart(2, '0')}`).join('')}.mkv`;
			}),
			generateSeasonFolderName: vi.fn(
				(season: number) => `Season ${String(season).padStart(2, '0')}`
			)
		}
	});
}

describe('ReadyProviderFileMapper', () => {
	it('selects the largest eligible movie without trusting provider paths or links', async () => {
		const providerItem = item([
			file('sample', '/Sample/sample.mkv', { sizeBytes: 40 * 1024 ** 2 }),
			file('main', '/../../hostile/Provider Name.mkv', { sizeBytes: 9 * GIB }),
			file('unselected', '/larger.mkv', { sizeBytes: 10 * GIB, selected: false }),
			file('subtitle', '/movie.srt')
		]);
		Object.assign(providerItem, {
			directUrl: 'https://provider.invalid/file?token=secret&signature=secret'
		});

		const result = await mapper().map({ providerItem, context: movie });

		expect(result.files).toHaveLength(1);
		expect(result.files[0]).toMatchObject({
			providerFileRef: { providerItemId: 'provider-item', providerFileId: 'main' },
			media: { movieId: 'movie' },
			plan: {
				finalPath: '/library/movies/Movie (2026)/Movie (2026) Bluray-1080p.mkv'
			}
		});
		expect(JSON.stringify(result)).not.toMatch(/hostile|provider name|secret|https?:/i);
	});

	it('prefers the preferred-language variant among equal-size movie files', async () => {
		const providerItem = item([
			file('en', '/Movie.2026.1080p.ENG.mkv', { sizeBytes: 9 * GIB }),
			file('es', '/Movie.2026.1080p.ESP.mkv', { sizeBytes: 9 * GIB })
		]);

		const result = await mapper().map({
			providerItem,
			context: movie,
			preferredAudioLanguages: ['es', 'en']
		});

		expect(result.files[0].providerFileRef.providerFileId).toBe('es');
	});

	it('keeps the largest file when no preferred language matches the names', async () => {
		const providerItem = item([
			file('big', '/Movie.2026.1080p.mkv', { sizeBytes: 10 * GIB }),
			file('small-es', '/Movie.2026.480p.ESP.mkv', { sizeBytes: 2 * GIB })
		]);

		const result = await mapper().map({
			providerItem,
			context: movie,
			preferredAudioLanguages: ['es']
		});

		// The ESP file is far smaller - size wins, the tiebreaker only applies
		// among near-equal candidates.
		expect(result.files[0].providerFileRef.providerFileId).toBe('big');
	});

	it('maps both multi-episode and multi-file releases without omitting queued episodes', async () => {
		const multiEpisode = await mapper().map({
			providerItem: item([file('both', '/Show.S01E01-E02.mkv')]),
			context: series()
		});
		expect(multiEpisode.files[0].media.episodeIds).toEqual(['e1', 'e2']);

		const multiFile = await mapper().map({
			providerItem: item([file('one', '/Show.S01E01.mkv'), file('two', '/Show.S01E02.mkv')]),
			context: series()
		});
		expect(multiFile.files.map(({ media }) => media.episodeIds)).toEqual([['e1'], ['e2']]);
	});

	it('ignores clearly unqueued episode files while mapping every queued episode', async () => {
		const result = await mapper().map({
			providerItem: item([
				file('one', '/Show.S01E01.mkv'),
				file('two', '/Show.S01E02.mkv'),
				file('extra', '/Show.S01E03.mkv')
			]),
			context: series()
		});

		expect(result.files.map(({ providerFileRef }) => providerFileRef.providerFileId)).toEqual([
			'one',
			'two'
		]);
	});

	it('explains a provider pack from a different series year', async () => {
		const context = series(['e1', 'e2'], 'DuckTales Complete Series');
		context.media.series.title = 'DuckTales';
		context.media.series.year = 2017;

		await expect(
			mapper().map({
				providerItem: item([
					file('old-one', '/DuckTales/Season 1/DuckTales Season 1 Episode 21 - 1987.mp4'),
					file('old-two', '/DuckTales/Season 1/DuckTales Season 1 Episode 22 - 1987.mp4')
				]),
				context
			})
		).rejects.toThrow(/provider content year 1987.*DuckTales \(2017\)/i);
	});

	it.each([
		['has no playable files', item([file('subtitle', '/show.srt')]), series(), /playable/i],
		[
			'contains only an unqueued episode',
			item([file('three', '/Show.S01E03.mkv')]),
			series(),
			/omitted/i
		],
		['omits a queued episode', item([file('one', '/Show.S01E01.mkv')]), series(), /omitted/i],
		[
			'maps two files to one episode',
			item([file('one', '/Show.S01E01.mkv'), file('duplicate', '/Other.S01E01.mkv')]),
			series(['e1'], 'Show S01E01 1080p'),
			/same episode/i
		]
	])('rejects a ready item that %s', async (_label, providerItem, context, error) => {
		await expect(mapper().map({ providerItem, context })).rejects.toThrow(error);
	});

	it('uses queue context as the fallback for one obfuscated episode file', async () => {
		const result = await mapper().map({
			providerItem: item([file('obfuscated', '/abc123.mkv')]),
			context: series(['e1'], 'Show S01E01 1080p')
		});
		expect(result.files[0].media.episodeIds).toEqual(['e1']);
	});

	it('does not expose signed provider data in mapping errors', async () => {
		const signed = 'https://provider.invalid/file.mkv?token=secret&signature=secret';
		let error: unknown;
		try {
			await mapper().map({
				providerItem: item([file('bad', signed)]),
				context: series()
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(JSON.stringify(error)).not.toMatch(/token=|signature=|provider\.invalid/i);
	});
});
