import { basename, extname } from 'node:path';
import { DOWNLOAD, EXCLUDED_FILE_PATTERNS, isVideoFile } from '#lib/config/constants.js';
import { getMediaParseStem } from '#lib/server/library/media-utils.js';
import { parseEpisodeMarker } from '#lib/server/library/episode-marker.js';

export type ImportCandidateRejection =
	'not-video' | 'too-small' | 'sample' | 'extra-folder' | 'extra-name';

export type ImportCandidateVerdict =
	{ importable: true } | { importable: false; reason: ImportCandidateRejection };

export interface ImportCandidateOptions {
	/** Accept .strm stubs regardless of size (mount-mode clients). */
	allowStrmSmall?: boolean;
	/** The caller already confirmed by magic bytes that an extensionless file is video. */
	extensionlessIsVideo?: boolean;
}

const STRM_EXTENSIONS = ['.strm'] as const;

const SAMPLE_PATTERN = /\bsample\b/i;

/** Folder names that hold bonus material rather than episodes, checked per path segment. */
const EXTRA_FOLDER_PATTERN =
	/^(?:samples?|extras?|bonus(?:es)?|featurettes?|trailers?|teasers?|promos?|behind[\s._-]?the[\s._-]?scenes?|deleted[\s._-]?scenes?|special[\s._-]?features?)$/i;

/**
 * Decide whether a downloaded file is a real media file worth importing.
 *
 * `relativePath` is the path inside the download (e.g. `Extras/Show.S01E01.mkv`),
 * so folders above the download root never influence the verdict.
 *
 * A file named after its episode is trusted further than a bare name: an episode
 * titled "The Trailer" or "Bonus Round", or a short episode under the generic
 * size floor, is still an episode. "Named after its episode" is
 * `parseEpisodeMarker`'s definition (SxxExx, NxNN, daily dates, absolute
 * numbers), so a short anime episode named `Show - 05` is not lost to the floor
 * that a two-hour movie needs. Samples are still rejected by name, and anything
 * inside an extras/sample folder stays out.
 */
export function classifyImportCandidate(
	relativePath: string,
	size: number,
	options: ImportCandidateOptions = {}
): ImportCandidateVerdict {
	const normalized = relativePath.replace(/\\/g, '/');
	const fileName = basename(normalized);
	const ext = extname(fileName).toLowerCase();

	const isVideo =
		isVideoFile(fileName, STRM_EXTENSIONS) || (ext === '' && options.extensionlessIsVideo === true);
	if (!isVideo) {
		return { importable: false, reason: 'not-video' };
	}

	if (SAMPLE_PATTERN.test(fileName)) {
		return { importable: false, reason: 'sample' };
	}

	const folders = normalized.split('/').slice(0, -1);
	if (folders.some((segment) => EXTRA_FOLDER_PATTERN.test(segment.trim()))) {
		return { importable: false, reason: 'extra-folder' };
	}

	const explicitEpisode = parseEpisodeMarker(getMediaParseStem(fileName)) !== null;
	const isSmallStrm = options.allowStrmSmall === true && ext === '.strm';
	// The episode floor only ever relaxes the generic one, never tightens it
	const minSize = explicitEpisode
		? Math.min(DOWNLOAD.MIN_EPISODE_IMPORT_SIZE_BYTES, DOWNLOAD.MIN_IMPORT_SIZE_BYTES)
		: DOWNLOAD.MIN_IMPORT_SIZE_BYTES;
	if (!isSmallStrm && size < minSize) {
		return { importable: false, reason: 'too-small' };
	}

	if (!explicitEpisode && EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(fileName))) {
		return { importable: false, reason: 'extra-name' };
	}

	return { importable: true };
}
