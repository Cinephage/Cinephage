import type { PageServerLoad } from './$types.js';
import { getLibraryEntityService } from '#lib/server/library/LibraryEntityService.js';
import { musicAlbumService } from '#lib/server/music/MusicAlbumService.js';
import { musicArtistService } from '#lib/server/music/MusicArtistService.js';
import { musicTrackService } from '#lib/server/music/MusicTrackService.js';
import { musicProfileService } from '#lib/server/music/MusicProfileService.js';
import type { ArtistCardData } from '#lib/components/music/music-card.js';
import { musicScanIssueService } from '#lib/server/music/MusicScanIssueService.js';

/**
 * The music library list, artist-first.
 *
 * Albums stay the row acquisition and monitoring act on, but a music collection
 * browses by artist — so the rollup (album counts, how many have files, which
 * album supplies the tile art) is derived here once instead of in the client.
 * Nothing here touches the filesystem: `hasFile` is the cache the importer
 * maintains, exactly like `movies.has_file`.
 */
export const load: PageServerLoad = async () => {
	const libraries = await getLibraryEntityService().listLibraries({ mediaType: 'music' });
	const library = libraries.find((entry) => entry.isDefault) ?? libraries[0] ?? null;

	// The list is every music library, like the movie list. The default library
	// still supplies the header/root-folder facts and the fallback profile.
	const albums = musicAlbumService.listAlbums();
	const songsTotal = musicTrackService.countTracks();
	const artistRows = musicArtistService.listArtists([
		...new Set(albums.map((album) => album.artistId))
	]);
	const artistProfile = new Map(artistRows.map((artist) => [artist.id, artist.qualityProfileId]));
	const libraryProfile = new Map(libraries.map((entry) => [entry.id, entry.qualityProfileId]));

	// Filtering by profile has to mean the profile a grab would actually use,
	// not only an explicit override: album -> artist -> library -> default.
	const albumsWithProfile = albums.map((album) => ({
		...album,
		effectiveProfileId: musicProfileService.resolve(
			album.qualityProfileId,
			artistProfile.get(album.artistId) ?? null,
			libraryProfile.get(album.libraryId ?? '') ?? null
		).id
	}));

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
		albums: albumsWithProfile,
		artists,
		songs: [],
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
			albums: albums.length,
			artists: artists.length,
			songs: songsTotal,
			missing: albums.filter((album) => !album.hasFile && !album.streamSource).length,
			monitored: albums.filter((album) => album.monitored).length
		}
	};
};
