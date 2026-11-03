import { basename, extname } from 'node:path';

const TRANSPORT_AND_MEDIA_EXTENSIONS = new Set([
	'.strm',
	'.mkv',
	'.mp4',
	'.avi',
	'.mov',
	'.m4v',
	'.wmv',
	'.flv',
	'.webm',
	'.mpg',
	'.mpeg',
	'.ts',
	'.m2ts',
	'.mts'
]);

/**
 * Strip all known media/transport extensions from a file path and return the
 * bare stem - e.g. "Movie.Title.1080p.mkv" → "Movie.Title.1080p".
 *
 * Uses the original-case extension from path.extname() when calling
 * path.basename() so the strip is case-insensitive on Linux (where
 * path.basename is case-sensitive and basename('movie.MKV', '.mkv') would
 * return the name unchanged, creating an infinite loop).
 */
export function getMediaParseStem(pathValue: string): string {
	let fileName = basename(pathValue);

	while (true) {
		const originalExt = extname(fileName);
		const extension = originalExt.toLowerCase();
		if (!extension || !TRANSPORT_AND_MEDIA_EXTENSIONS.has(extension)) {
			return fileName;
		}

		fileName = basename(fileName, originalExt);
	}
}
