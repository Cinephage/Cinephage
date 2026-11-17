import { basename, extname } from 'node:path';
import { DOWNLOAD, EXCLUDED_FILE_PATTERNS, isVideoFile } from '#lib/config/constants.js';

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

const EPISODE_MARKER_PATTERNS = [/\bS\d{1,2}[\s._-]?E\d{1,3}\b/i, /\b\d{1,2}x\d{2,3}\b/i];

export function hasExplicitEpisodeMarker(fileName: string): boolean {
	return EPISODE_MARKER_PATTERNS.some((pattern) => pattern.test(fileName));
}

/**
 * Decide whether a downloaded file is a real media file worth importing.
 *
 * `relativePath` is the path inside the download (e.g. `Extras/Show.S01E01.mkv`),
 * so folders above the download root never influence the verdict.
 *
 * A file named with an explicit episode marker is trusted further than a bare
 * name: an episode titled "The Trailer" or "Bonus Round", or a short episode
 * under the generic size floor, is still an episode. Samples are still rejected
 * by name, and anything inside an extras/sample folder stays out.
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

	const explicitEpisode = hasExplicitEpisodeMarker(fileName);
	const isSmallStrm = options.allowStrmSmall === true && ext === '.strm';
	const minSize = explicitEpisode
		? DOWNLOAD.MIN_EPISODE_IMPORT_SIZE_BYTES
		: DOWNLOAD.MIN_IMPORT_SIZE_BYTES;
	if (!isSmallStrm && size < minSize) {
		return { importable: false, reason: 'too-small' };
	}

	if (!explicitEpisode && EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(fileName))) {
		return { importable: false, reason: 'extra-name' };
	}

	return { importable: true };
}
