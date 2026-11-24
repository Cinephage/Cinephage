import type { KindId } from '#lib/media-kinds/types.js';

interface RootFolderLike {
	id: string;
	name: string;
	mediaType: string;
	mediaSubType?: string | null;
	isDefault?: boolean;
	readOnly?: boolean;
}

export function getWritableRootFoldersForMediaType<T extends RootFolderLike>(
	rootFolders: T[],
	mediaType: KindId,
	mediaSubType?: 'standard' | 'anime'
): T[] {
	return sortRootFoldersForMediaType(
		rootFolders.filter((folder) => !folder.readOnly),
		mediaType,
		mediaSubType
	);
}

export function sortRootFoldersForMediaType<T extends RootFolderLike>(
	rootFolders: T[],
	mediaType: KindId,
	mediaSubType?: 'standard' | 'anime'
): T[] {
	const subtypeRank = (subType: string | null | undefined): number =>
		(subType ?? 'standard') === 'anime' ? 1 : 0;

	return rootFolders
		.filter((folder) => {
			if (folder.mediaType !== mediaType) return false;
			if (!mediaSubType) return true;
			return (folder.mediaSubType ?? 'standard') === mediaSubType;
		})
		.sort((a, b) => {
			if (Boolean(a.isDefault) !== Boolean(b.isDefault)) {
				return a.isDefault ? -1 : 1;
			}

			// When no subtype filter is applied, keep standard folders ahead of anime
			// so "default" selection remains predictable for general media flows.
			if (!mediaSubType) {
				const subtypeDelta = subtypeRank(a.mediaSubType) - subtypeRank(b.mediaSubType);
				if (subtypeDelta !== 0) {
					return subtypeDelta;
				}
			}

			return a.name.localeCompare(b.name);
		});
}
