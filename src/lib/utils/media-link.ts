import { resolvePath } from '#lib/utils/routing.js';

/**
 * Build a TVDB series URL using a slug derived from the title.
 * TVDB changed their URL format from /series/{numericId} to /series/{slug}.
 * Slugs are the lowercase-hyphenated title with non-alphanumeric
 * characters replaced, which matches TVDB's own slug generation.
 */
export function tvdbSeriesUrl(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
	return `https://thetvdb.com/series/${slug}`;
}

export function getMediaLink(activity: {
	mediaType: string;
	mediaId: number | string;
	seriesId?: number | string | null;
}): string {
	if (activity.mediaType === 'movie') return resolvePath(`/library/movie/${activity.mediaId}`);
	return resolvePath(`/library/tv/${activity.seriesId || activity.mediaId}`);
}

export function canLinkToMedia(activity: {
	status?: string;
	mediaType: string;
	mediaId?: number | string | null;
	seriesId?: number | string | null;
}): boolean {
	if (activity.status === 'removed') return false;
	if (activity.mediaType === 'movie') return Boolean(activity.mediaId);
	return Boolean(activity.seriesId || activity.mediaId);
}
