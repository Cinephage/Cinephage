/**
 * Quality Backfill Service
 *
 * Parses quality information from filenames for files that have NULL quality data.
 * This fixes historical data that was imported before quality parsing was properly stored.
 */

import { db } from '#lib/server/db/index.js';
import { episodeFiles, movieFiles } from '#lib/server/db/schema.js';
import { eq } from 'drizzle-orm';
import { ReleaseParser } from '#lib/server/indexers/parser/ReleaseParser.js';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'scans' as const });

const parser = new ReleaseParser();

/**
 * Normalize source names to standard capitalized format
 */
function normalizeSource(source: string | null | undefined): string | undefined {
	if (!source || source === 'unknown') return undefined;

	const normalized = source.toLowerCase();
	const sourceMap: Record<string, string> = {
		bluray: 'Bluray',
		'blu-ray': 'Bluray',
		bdrip: 'Bluray',
		brrip: 'Bluray',
		remux: 'Remux',
		webdl: 'WEBDL',
		'web-dl': 'WEBDL',
		'web dl': 'WEBDL',
		webrip: 'WEBRip',
		'web-rip': 'WEBRip',
		web: 'WEB',
		hdtv: 'HDTV',
		pdtv: 'PDTV',
		dsr: 'DSR',
		dvdrip: 'DVDRip',
		dvd: 'DVD',
		hdcam: 'HDCAM',
		hdrip: 'HDRip',
		cam: 'CAM',
		telesync: 'TS',
		ts: 'TS',
		telecine: 'TC',
		tc: 'TC',
		screener: 'SCR',
		scr: 'SCR',
		r5: 'R5'
	};

	return sourceMap[normalized] || source.toUpperCase();
}

/**
 * Normalize video codec names to standard format
 */
function normalizeCodec(codec: string | null | undefined): string | undefined {
	if (!codec || codec === 'unknown') return undefined;

	const normalized = codec.toLowerCase();
	const codecMap: Record<string, string> = {
		x264: 'x264',
		h264: 'x264',
		'h.264': 'x264',
		avc: 'x264',
		x265: 'x265',
		h265: 'x265',
		'h.265': 'x265',
		hevc: 'x265',
		xvid: 'XviD',
		divx: 'DivX',
		av1: 'AV1',
		vp9: 'VP9',
		mpeg2: 'MPEG2'
	};

	return codecMap[normalized] || codec.toUpperCase();
}

/**
 * Normalize HDR format names
 */
function normalizeHdr(hdr: string | null | undefined): string | undefined {
	if (!hdr) return undefined;

	const normalized = hdr.toLowerCase();
	const hdrMap: Record<string, string> = {
		hdr: 'HDR',
		hdr10: 'HDR10',
		'hdr10+': 'HDR10+',
		hdr10plus: 'HDR10+',
		dv: 'DV',
		'dolby vision': 'DV',
		dolbyvision: 'DV',
		hlg: 'HLG'
	};

	return hdrMap[normalized] || hdr.toUpperCase();
}

export interface BackfillResult {
	episodeFilesUpdated: number;
	movieFilesUpdated: number;
	episodeFilesSkipped: number;
	movieFilesSkipped: number;
	errors: string[];
}

/**
 * Backfill and normalize quality data for ALL files
 * Re-parses quality from filenames and applies proper capitalization
 */
export async function backfillMissingQuality(): Promise<BackfillResult> {
	const result: BackfillResult = {
		episodeFilesUpdated: 0,
		movieFilesUpdated: 0,
		episodeFilesSkipped: 0,
		movieFilesSkipped: 0,
		errors: []
	};

	// Backfill ALL episode files (not just NULL)
	try {
		const allEpisodeFiles = await db
			.select({
				id: episodeFiles.id,
				sceneName: episodeFiles.sceneName,
				relativePath: episodeFiles.relativePath
			})
			.from(episodeFiles);

		logger.info({ count: allEpisodeFiles.length }, '[QualityBackfill] Processing episode files');

		for (const file of allEpisodeFiles) {
			try {
				// Use sceneName if available (has original release name with quality markers)
				// Fall back to relativePath if sceneName is not available
				const nameToparse =
					file.sceneName || file.relativePath.split('/').pop() || file.relativePath;
				const parsed = parser.parse(nameToparse);

				// Normalize the values with proper capitalization
				const resolution = parsed.resolution !== 'unknown' ? parsed.resolution : undefined;
				const source = normalizeSource(parsed.source);
				const codec = normalizeCodec(parsed.codec);
				const hdr = normalizeHdr(parsed.hdr);

				// Only update if we parsed any quality info
				if (resolution || source || codec) {
					await db
						.update(episodeFiles)
						.set({
							quality: { resolution, source, codec, hdr }
						})
						.where(eq(episodeFiles.id, file.id));

					result.episodeFilesUpdated++;
				} else {
					result.episodeFilesSkipped++;
				}
			} catch (err) {
				const errorMsg = `Failed to update episode file ${file.id}: ${err instanceof Error ? err.message : String(err)}`;
				result.errors.push(errorMsg);
				logger.error(
					{
						fileId: file.id,
						errorMsg
					},
					'[QualityBackfill] Episode file update failed'
				);
			}
		}
	} catch (err) {
		const errorMsg = `Failed to fetch episode files: ${err instanceof Error ? err.message : String(err)}`;
		result.errors.push(errorMsg);
		logger.error(
			'[QualityBackfill] Failed to fetch episode files',
			err instanceof Error ? err : undefined
		);
	}

	// Backfill ALL movie files (not just NULL)
	try {
		const allMovieFiles = await db
			.select({
				id: movieFiles.id,
				sceneName: movieFiles.sceneName,
				relativePath: movieFiles.relativePath
			})
			.from(movieFiles);

		logger.info({ count: allMovieFiles.length }, '[QualityBackfill] Processing movie files');

		for (const file of allMovieFiles) {
			try {
				// Use sceneName if available (has original release name with quality markers)
				// Fall back to relativePath if sceneName is not available
				const nameToParse =
					file.sceneName || file.relativePath.split('/').pop() || file.relativePath;
				const parsed = parser.parse(nameToParse);

				// Normalize the values with proper capitalization
				const resolution = parsed.resolution !== 'unknown' ? parsed.resolution : undefined;
				const source = normalizeSource(parsed.source);
				const codec = normalizeCodec(parsed.codec);
				const hdr = normalizeHdr(parsed.hdr);

				// Only update if we parsed any quality info
				if (resolution || source || codec) {
					await db
						.update(movieFiles)
						.set({
							quality: { resolution, source, codec, hdr }
						})
						.where(eq(movieFiles.id, file.id));

					result.movieFilesUpdated++;
				} else {
					result.movieFilesSkipped++;
				}
			} catch (err) {
				const errorMsg = `Failed to update movie file ${file.id}: ${err instanceof Error ? err.message : String(err)}`;
				result.errors.push(errorMsg);
				logger.error(
					{
						fileId: file.id,
						errorMsg
					},
					'[QualityBackfill] Movie file update failed'
				);
			}
		}
	} catch (err) {
		const errorMsg = `Failed to fetch movie files: ${err instanceof Error ? err.message : String(err)}`;
		result.errors.push(errorMsg);
		logger.error(
			'[QualityBackfill] Failed to fetch movie files',
			err instanceof Error ? err : undefined
		);
	}

	logger.info({ ...result }, '[QualityBackfill] Complete');
	return result;
}
