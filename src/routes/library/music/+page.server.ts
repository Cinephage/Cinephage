import type { PageServerLoad } from './$types.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';

/**
 * The music library list. Albums are album-level rows (one per release group),
 * so this page never touches the filesystem — `hasFile` is the cache the importer
 * maintains, exactly like `movies.has_file`.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requireAdminPage(locals);

	const libraries = await getLibraryEntityService().listLibraries({ mediaType: 'music' });
	const library = libraries.find((entry) => entry.isDefault) ?? libraries[0] ?? null;

	return {
		library: library
			? {
					id: library.id,
					name: library.name,
					slug: library.slug,
					rootFolderPath: library.defaultRootFolderPath,
					rootFolderCount: library.rootFolders.length
				}
			: null,
		albums: musicAlbumService.listAlbums({ libraryId: library?.id ?? null })
	};
};
