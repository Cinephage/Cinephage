import type { PageServerLoad } from './$types.js';
import { requireAdminPage } from '#lib/server/auth/authorization.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { musicArtistService } from '#lib/server/music/MusicArtistService.js';
import { musicTrackService } from '#lib/server/music/MusicTrackService.js';
import { musicProfileService } from '#lib/server/music/MusicProfileService.js';
import type { ArtistCardData } from '#lib/components/music/music-card.js';

/**
 * The music library list, artist-first.
 *
 * Albums stay the row acquisition and monitoring act on, but a music collection
 * browses by artist — so the rollup (album counts, how many have files, which
 * album supplies the tile art) is derived here once instead of in the client.
 * Nothing here touches the filesystem: `hasFile` is the cache the importer
 * maintains, exactly like `movies.has_file`.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requireAdminPage(locals);

	const libraries = await getLibraryEntityService().listLibraries({ mediaType: 'music' });
	const library = libraries.find((entry) => entry.isDefault) ?? libraries[0] ?? null;
	const libraryId = library?.id ?? null;

	const albums = musicAlbumService.listAlbums({ libraryId });
	const songs = musicTrackService.listTracks({ libraryId });
	const artistRows = musicArtistService.listArtists([
		...new Set(albums.map((album) => album.artistId))
	]);

	const artists: ArtistCardData[] = artistRows.map((artist) => {
		const owned = albums.filter((album) => album.artistId === artist.id);
		const cover = owned.find((album) => album.hasCover) ?? null;
		return {
			id: artist.id,
			name: artist.name,
			mbid: artist.mbid,
			coverAlbumId: cover?.id ?? null,
			albumCount: owned.length,
			inLibraryCount: owned.filter((album) => album.hasFile).length,
			monitored: artist.monitored
		};
	});

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
		albums,
		artists,
		songs,
		qualityProfiles: musicProfileService.list().map((profile) => ({
			id: profile.id,
			name: profile.name,
			description: profile.description ?? '',
			isBuiltIn: profile.isBuiltIn,
			isDefault: profile.isDefault
		})),
		/** What an unassigned album inherits here: the library's profile first. */
		defaultProfileName: musicProfileService.resolve(null, null, library?.qualityProfileId).name,
		counts: {
			albums: albums.length,
			artists: artists.length,
			songs: songs.length,
			missing: albums.filter((album) => !album.hasFile).length,
			monitored: albums.filter((album) => album.monitored).length
		}
	};
};
