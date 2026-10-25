/**
 * Downloads poster/fanart artwork from TMDB into Kodi-standard sidecar
 * filenames, for media servers that read local artwork instead of (or in
 * addition to) fetching it themselves.
 */

import { writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ logDomain: 'imports' as const });

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/original';

export function tmdbImageUrl(path: string | null | undefined): string | null {
	return path ? `${TMDB_IMAGE_BASE}${path}` : null;
}

/** Shared by both artwork and NFO writes - true when the file should be written. */
export async function shouldWriteSidecar(path: string, overwrite: boolean): Promise<boolean> {
	if (overwrite) return true;
	return !(await pathExists(path));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Downloads one image to `destPath`, skipping it when the file already
 * exists and `overwrite` is false. (Non-blocking)
 */
export async function downloadSidecarImage(
	url: string | null,
	destPath: string,
	overwrite: boolean
): Promise<boolean> {
	if (!url) return false;

	try {
		if (!(await shouldWriteSidecar(destPath, overwrite))) {
			return false;
		}

		const response = await fetch(url);
		if (!response.ok) {
			logger.warn(
				{ url, destPath, status: response.status },
				'[Sidecar] Failed to download artwork - non-OK response'
			);
			return false;
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		await writeFile(destPath, buffer);
		return true;
	} catch (err) {
		logger.warn(
			{ url, destPath, err: err instanceof Error ? err.message : String(err) },
			'[Sidecar] Failed to download artwork'
		);
		return false;
	}
}

/** Movie poster.jpg/fanart.jpg live directly in the movie's own folder. */
export function movieArtworkPaths(movieFolderPath: string): { poster: string; fanart: string } {
	return {
		poster: join(movieFolderPath, 'poster.jpg'),
		fanart: join(movieFolderPath, 'fanart.jpg')
	};
}

/** Series poster.jpg/fanart.jpg live at the series root folder. */
export function seriesArtworkPaths(seriesFolderPath: string): { poster: string; fanart: string } {
	return {
		poster: join(seriesFolderPath, 'poster.jpg'),
		fanart: join(seriesFolderPath, 'fanart.jpg')
	};
}

/**
 * Season posters live alongside the show's own
 * poster.jpg at the series root, named seasonNN-poster.jpg (zero-padded),
 * not inside the season's own subfolder.
 */
export function seasonArtworkPath(seriesFolderPath: string, seasonNumber: number): string {
	const padded = String(seasonNumber).padStart(2, '0');
	return join(seriesFolderPath, `season${padded}-poster.jpg`);
}

/** The folder a media file lives in - used as the movie/series root for artwork. */
export function folderOf(mediaFilePath: string): string {
	return dirname(mediaFilePath);
}
