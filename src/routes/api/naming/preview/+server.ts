import type { RequestHandler } from './$types';
import {
	NamingService,
	type MediaNamingInfo,
	type NamingConfig
} from '#lib/server/library/naming/NamingService.js';
import { namingSettingsService } from '#lib/server/library/naming/NamingSettingsService.js';
import { requireAdmin } from '#lib/server/auth/authorization.js';
import { namingPreviewSchema } from '#lib/validation/schemas.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'NamingPreviewApi', logDomain: 'scans' });

/**
 * Sample data for previews
 */
const SAMPLE_MOVIE: MediaNamingInfo = {
	title: 'The Dark Knight',
	year: 2008,
	tmdbId: 155,
	imdbId: 'tt0468569',
	resolution: '2160p',
	source: 'Remux',
	codec: 'x265',
	hdr: 'DV',
	audioCodec: 'TrueHD Atmos',
	audioChannels: '7.1',
	releaseGroup: 'FraMeSToR',
	proper: false,
	repack: false,
	edition: undefined,
	originalExtension: '.mkv'
};

const SAMPLE_MOVIE_WITH_EDITION: MediaNamingInfo = {
	...SAMPLE_MOVIE,
	title: 'Blade Runner 2049',
	year: 2017,
	tmdbId: 335984,
	edition: 'Directors Cut',
	proper: true
};

const SAMPLE_EPISODE: MediaNamingInfo = {
	title: 'Breaking Bad',
	year: 2008,
	tvdbId: 81189,
	tmdbId: 1396,
	seasonNumber: 1,
	episodeNumbers: [1],
	episodeTitle: 'Pilot',
	resolution: '1080p',
	source: 'Bluray',
	codec: 'x265',
	hdr: undefined,
	audioCodec: 'DTS-HD MA',
	audioChannels: '5.1',
	releaseGroup: 'DEMAND',
	proper: false,
	repack: false,
	originalExtension: '.mkv'
};

const SAMPLE_MULTI_EPISODE: MediaNamingInfo = {
	...SAMPLE_EPISODE,
	episodeNumbers: [1, 2, 3],
	episodeTitle: 'Pilot'
};

const SAMPLE_ANIME: MediaNamingInfo = {
	title: 'Attack on Titan',
	year: 2013,
	tvdbId: 267440,
	seasonNumber: 1,
	episodeNumbers: [1],
	absoluteNumber: 1,
	episodeTitle: 'To You, in 2000 Years: The Fall of Shiganshina, Part 1',
	resolution: '1080p',
	source: 'Bluray',
	codec: 'x265',
	bitDepth: '10',
	audioCodec: 'FLAC',
	audioChannels: '2.0',
	releaseGroup: 'Judas',
	isAnime: true,
	originalExtension: '.mkv'
};

const SAMPLE_DAILY: MediaNamingInfo = {
	title: 'The Daily Show',
	year: 1996,
	tvdbId: 71256,
	airDate: '2024-03-15',
	episodeTitle: 'Guest Interview',
	resolution: '720p',
	source: 'WEB-DL',
	codec: 'x264',
	releaseGroup: 'HULU',
	isDaily: true,
	originalExtension: '.mkv'
};

/**
 * POST /api/naming/preview
 * Generate preview filenames based on provided config
 */
export const POST: RequestHandler = async (event) => {
	const authError = requireAdmin(event);
	if (authError) return authError;

	const { request } = event;
	try {
		const parsed = namingPreviewSchema.safeParse(await request.json());
		if (!parsed.success) {
			return Response.json(
				{ success: false, error: parsed.error.issues[0].message },
				{ status: 400 }
			);
		}
		const { config: customConfig } = parsed.data;

		// Merge custom config with current settings
		const currentConfig = await namingSettingsService.getConfig();
		const mergedConfig: NamingConfig = customConfig
			? { ...currentConfig, ...customConfig }
			: currentConfig;

		const namingService = new NamingService(mergedConfig);

		// Generate all previews
		const previews = {
			movie: {
				folder: namingService.generateMovieFolderName(SAMPLE_MOVIE),
				file: namingService.generateMovieFileName(SAMPLE_MOVIE)
			},
			movieWithEdition: {
				folder: namingService.generateMovieFolderName(SAMPLE_MOVIE_WITH_EDITION),
				file: namingService.generateMovieFileName(SAMPLE_MOVIE_WITH_EDITION)
			},
			series: {
				folder: namingService.generateSeriesFolderName(SAMPLE_EPISODE),
				season: namingService.generateSeasonFolderName(1, SAMPLE_EPISODE)
			},
			episode: {
				file: namingService.generateEpisodeFileName(SAMPLE_EPISODE)
			},
			multiEpisode: {
				file: namingService.generateEpisodeFileName(SAMPLE_MULTI_EPISODE)
			},
			anime: {
				file: namingService.generateEpisodeFileName(SAMPLE_ANIME)
			},
			daily: {
				file: namingService.generateEpisodeFileName(SAMPLE_DAILY)
			}
		};

		return Response.json({
			previews,
			config: mergedConfig,
			sampleData: {
				movie: SAMPLE_MOVIE,
				episode: SAMPLE_EPISODE
			}
		});
	} catch (error) {
		logger.error('Error generating naming preview', error instanceof Error ? error : undefined);
		return Response.json({ error: 'Failed to generate naming preview' }, { status: 500 });
	}
};

/**
 * GET /api/naming/preview
 * Get preview with current configuration
 */
export const GET: RequestHandler = async () => {
	try {
		const config = await namingSettingsService.getConfig();
		const namingService = new NamingService(config);

		const previews = {
			movie: {
				folder: namingService.generateMovieFolderName(SAMPLE_MOVIE),
				file: namingService.generateMovieFileName(SAMPLE_MOVIE)
			},
			movieWithEdition: {
				folder: namingService.generateMovieFolderName(SAMPLE_MOVIE_WITH_EDITION),
				file: namingService.generateMovieFileName(SAMPLE_MOVIE_WITH_EDITION)
			},
			series: {
				folder: namingService.generateSeriesFolderName(SAMPLE_EPISODE),
				season: namingService.generateSeasonFolderName(1, SAMPLE_EPISODE)
			},
			episode: {
				file: namingService.generateEpisodeFileName(SAMPLE_EPISODE)
			},
			multiEpisode: {
				file: namingService.generateEpisodeFileName(SAMPLE_MULTI_EPISODE)
			},
			anime: {
				file: namingService.generateEpisodeFileName(SAMPLE_ANIME)
			},
			daily: {
				file: namingService.generateEpisodeFileName(SAMPLE_DAILY)
			}
		};

		return Response.json({
			previews,
			config
		});
	} catch (error) {
		logger.error('Error getting naming preview', error instanceof Error ? error : undefined);
		return Response.json({ error: 'Failed to get naming preview' }, { status: 500 });
	}
};
