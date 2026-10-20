/**
 * storage_items tracks TV content per-episode, so a show with many
 * untracked episodes would otherwise appear once per episode. Both the
 * UntrackedByCinephageRule (count/breakdown) and its detail resolver
 * (untracked-by-cinephage.ts) group rows the same way so the summary text
 * and the detail list never disagree on how many distinct shows/movies are
 * affected.
 *
 * Grouped by tmdbId when present. A TV row without a resolved tmdbId (the
 * media server's metadata agent never matched the show) still groups by
 * seriesName instead of falling back to one row per episode - series/show
 * names are reported consistently per episode by every provider, unlike
 * title matching across different media which risks cross-title collisions.
 * A movie without a resolved tmdbId has no safe grouping key and falls back
 * to one row per item.
 */
export type UntrackedGroupableRow = {
	id: string;
	tmdbId: number | null;
	itemType: string;
	seriesName: string | null;
};

export function untrackedGroupKey(row: UntrackedGroupableRow): string {
	const isMovie = row.itemType === 'movie';
	if (row.tmdbId != null) return `${isMovie ? 'm' : 's'}-${row.tmdbId}`;
	if (!isMovie && row.seriesName) return `sn-${row.seriesName}`;
	return `row-${row.id}`;
}
