/**
 * Music metadata shapes, mapped from MusicBrainz.
 *
 * Deliberately separate from `metadata/providers/types.ts`: that interface is
 * title→details for a single video/animé subject, and forcing album→tracklist
 * through it would have made both sides lie about their shape.
 */

export interface MusicArtistRef {
	mbid: string;
	name: string;
	sortName?: string | null;
}

/** One MusicBrainz release group — the *work*, which is what an album row is. */
export interface MusicReleaseGroup {
	mbid: string;
	title: string;
	/** Album, EP, Single, Broadcast, Other. */
	primaryType?: string | null;
	/** Compilation, Live, Soundtrack, Remix, DJ-mix… */
	secondaryTypes: string[];
	/** ISO date (yyyy-mm-dd, or a prefix of it) as MusicBrainz reports it. */
	firstReleaseDate?: string | null;
	year?: number | null;
	artist: MusicArtistRef;
	/** Genres MusicBrainz files the release group under; absent when none. */
	genres?: string[];
	/** MusicBrainz relevance score for a search hit (0-100); absent on direct lookups. */
	score?: number;
}

/** One track of a specific release (an edition), not of the work. */
export interface MusicTrack {
	recordingMbid?: string | null;
	title: string;
	artistCredit?: string | null;
	/** 1-based medium number; a single-disc release is 1. */
	discNumber: number;
	/** Track number inside the medium; null when MusicBrainz prints something non-numeric (e.g. "A1"). */
	trackNumber: number | null;
	/** Sort key across the whole release, disc-major. */
	position: number;
	/** Seconds, rounded from MusicBrainz milliseconds. */
	duration?: number | null;
}

/**
 * An edition of a release group, before its tracklist is fetched. Enough to
 * choose which edition to track, and nothing more.
 */
export interface MusicReleaseSummary {
	mbid: string;
	title: string;
	status?: string | null;
	date?: string | null;
	year?: number | null;
	country?: string | null;
	trackCount: number;
}

/** One MusicBrainz release — a concrete edition of a release group. */
export interface MusicRelease {
	mbid: string;
	title: string;
	/** Official, Promotion, Bootleg, Pseudo-Release. */
	status?: string | null;
	country?: string | null;
	barcode?: string | null;
	packaging?: string | null;
	labelName?: string | null;
	catalogNumber?: string | null;
	date?: string | null;
	year?: number | null;
	mediaCount: number;
	trackCount: number;
	/** Total runtime in seconds, summed over the tracklist. */
	duration: number;
	tracks: MusicTrack[];
}

export interface MusicArtistDetail extends MusicArtistRef {
	disambiguation?: string | null;
	/** Person, Group, Other… */
	type?: string | null;
	country?: string | null;
	genres: string[];
}

/** An artist search hit (before any album exists). */
export interface MusicArtistSearchResult {
	mbid: string;
	name: string;
	sortName?: string | null;
	disambiguation?: string | null;
	type?: string | null;
	country?: string | null;
	score?: number;
}

/**
 * One song hit. A recording is not a product: it belongs to a release, and the
 * release belongs to a release group (the album). `releaseGroup` is what "add
 * this song" hands to the album importer; `releaseMbid` is the edition it came
 * from.
 */
export interface MusicRecordingHit {
	mbid: string;
	title: string;
	/** Seconds, rounded from MusicBrainz milliseconds. */
	duration?: number | null;
	/** Rendered credit, e.g. "Emilio Rojas & Chris Webby". */
	artistCredit: string;
	artists: MusicArtistRef[];
	releaseGroup: {
		mbid: string;
		title: string;
		primaryType?: string | null;
		/** Compilation, Live, Remix… — a compilation is rarely the album a song is on. */
		secondaryTypes?: string[];
		firstReleaseDate?: string | null;
		/** The release's artist credit, which is also the release group's artist. */
		artist?: MusicArtistRef | null;
	} | null;
	releaseMbid: string | null;
	/**
	 * True when the chosen release is credited to the recording's own artist
	 * rather than a Various Artists compilation. A playlist import must pick the
	 * owned hit when one exists: the compilation is not the album the song is on.
	 */
	releaseOwned?: boolean;
	score?: number;
}
