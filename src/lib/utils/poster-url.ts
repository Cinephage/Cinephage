// Served through Cinephage's local image cache (src/lib/server/tmdb-image-cache.ts).
const TMDB_IMAGE_BASE = '/api/images/tmdb';

export function getPosterUrl(
	posterPath: string | null | undefined,
	size: 'w92' | 'w185' | 'w342' | 'w500' | 'w780' = 'w92'
): string {
	if (!posterPath) return '';
	if (posterPath.startsWith('http://') || posterPath.startsWith('https://')) return posterPath;
	return `${TMDB_IMAGE_BASE}/${size}${posterPath}`;
}
