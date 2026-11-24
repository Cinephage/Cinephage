import type { PageServerLoad } from './$types.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { musicProfileService } from '#lib/server/music/MusicProfileService.js';
import { musicScanIssueService } from '#lib/server/music/MusicScanIssueService.js';

/**
 * The music library list, artist-first.
 *
 * The rows themselves are fetched a window at a time from
 * `/api/music/{artists,albums,songs}`; this load carries only what the shell
 * needs before the first fetch — the library, the profile vocabulary, and the
 * counts. Shipping the lists here is what made the page grow with the library.
 * Nothing here touches the filesystem: `hasFile` is the cache the importer
 * maintains, exactly like `movies.has_file`.
 */
export const load: PageServerLoad = async () => {
	const libraries = await getLibraryEntityService().listLibraries({ mediaType: 'music' });
	const library = libraries.find((entry) => entry.isDefault) ?? libraries[0] ?? null;
	const counts = musicAlbumService.countLibrary();

	return {
		library: library
			? {
					id: library.id,
					name: library.name,
					slug: library.slug,
					rootFolderPath: library.defaultRootFolderPath,
					rootFolderCount: library.rootFolders.length,
					defaultSearchOnAdd: library.defaultSearchOnAdd
				}
			: null,
		libraries: libraries.map((entry) => ({
			id: entry.id,
			name: entry.name,
			isDefault: entry.isDefault
		})),
		qualityProfiles: musicProfileService.list().map((profile) => ({
			id: profile.id,
			name: profile.name,
			description: profile.description ?? '',
			isBuiltIn: profile.isBuiltIn,
			isDefault: profile.isDefault
		})),
		/** What an unassigned album inherits here: the library's profile first. */
		defaultProfileName: musicProfileService.resolve(null, null, library?.qualityProfileId).name,
		scanIssueCount: musicScanIssueService.countPending(),
		counts: {
			albums: counts.albums
		}
	};
};
