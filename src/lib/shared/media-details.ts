/**
 * Facts every library detail sidebar derives the same way: the item's absolute
 * storage path and its anime-provider id rows.
 *
 * Both were written twice — once in the movie page, once in the series sidebar —
 * with identical bodies and slightly different labels, which is exactly how the
 * two detail surfaces drifted apart. One implementation, one set of labels.
 */

export interface ProviderRefs {
	anilist?: string | null;
	mal?: string | null;
}

/** Which anime providers this instance is configured with. */
export interface ProviderVisibility {
	anilist: boolean;
	mal: boolean;
}

export type ProviderRow =
	| { label: string; value: string; resolved: true; href: string; provider: 'anilist' | 'mal' }
	| { label: string; value: string; resolved: false; provider: 'anilist' | 'mal' };

interface ItemLike {
	rootFolderPath?: string | null;
	providerRefs?: ProviderRefs | null;
}

/** Absolute path of an item's folder, from its root folder plus stored relative path. */
export function mediaStoragePath(
	rootFolderPath: string | null | undefined,
	relativePath: string | null | undefined
): string {
	const rootPath = rootFolderPath ?? '';
	const relative = relativePath ?? '';

	if (!rootPath) return relative;
	if (!relative) return rootPath;

	const normalizedRoot = rootPath.endsWith('/') ? rootPath.slice(0, -1) : rootPath;
	const normalizedRelative = relative.startsWith('/') ? relative.slice(1) : relative;

	return `${normalizedRoot}/${normalizedRelative}`;
}

/** True when the item carries an AniList or MAL link. */
export function hasAnimeProviderLink(item: ItemLike): boolean {
	return Boolean(item.providerRefs?.anilist) || Boolean(item.providerRefs?.mal);
}

/**
 * One row per configured anime provider: the id when linked, `N/A` when the
 * provider is configured but this item has no id yet. Empty for non-anime items,
 * so a sidebar can render the rows without a second condition.
 */
export function animeProviderRows(item: ItemLike, configured: ProviderVisibility): ProviderRow[] {
	const isAnimeItem =
		(item.rootFolderPath ?? '').toLowerCase().includes('/anime/') || hasAnimeProviderLink(item);
	if (!isAnimeItem) return [];

	const refs = item.providerRefs ?? {};
	const rows: ProviderRow[] = [];

	const push = (provider: 'anilist' | 'mal', label: string, hrefBase: string): void => {
		if (!configured[provider]) return;
		const ref = refs[provider];
		rows.push(
			ref
				? { label, value: ref, resolved: true, href: `${hrefBase}${ref}`, provider }
				: { label, value: 'N/A', resolved: false, provider }
		);
	};

	push('anilist', 'AniList', 'https://anilist.co/anime/');
	push('mal', 'MAL', 'https://myanimelist.net/anime/');

	return rows;
}
