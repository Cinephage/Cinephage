/**
 * Matching an audio file to a track it was downloaded for.
 *
 * Kept apart from the importer because it is the only part with real branching,
 * and because it is the part that can be tested without a filesystem or a tag
 * reader. Three signals, strongest first: the tag's disc+track pair, the track
 * number in the file name, the title. A file that matches nothing is still a
 * file of the album — bonus tracks and skits exist — so it is kept with no track
 * link rather than dropped.
 */

export interface TrackRef {
	id: string;
	/** Null when MusicBrainz had no position; treated as disc 1, position 0. */
	discNumber: number | null;
	trackNumber: number | null;
	title: string;
}

export interface AudioFileRef {
	/** Disc number from tags, 1 when the file says nothing. */
	discNumber: number | null;
	/** Track number from tags, null when absent. */
	trackNumber: number | null;
	/** Title from tags, null when absent. */
	title: string | null;
	/** File name without its directory, used when tags are missing. */
	fileName: string;
}

/** Common normalisation: case, accents-free-ish punctuation, leading zeros gone. */
export function normalizeForMatch(value: string): string {
	return value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/** "01 - One More Time.flac" -> { track: 1, title: "One More Time" }. */
export function parseFileName(fileName: string): {
	trackNumber: number | null;
	title: string | null;
} {
	const withoutExtension = fileName.replace(/\.[a-z0-9]{2,5}$/i, '');
	const numbered = /^\s*(\d{1,3})\s*[-._)\s]\s*(.+)$/.exec(withoutExtension);
	if (numbered) {
		return { trackNumber: Number(numbered[1]), title: numbered[2].trim() };
	}
	const bare = /^\s*(\d{1,3})\s+(\D.+)$/.exec(withoutExtension);
	if (bare) {
		return { trackNumber: Number(bare[1]), title: bare[2].trim() };
	}
	return { trackNumber: null, title: withoutExtension.trim() || null };
}

/**
 * Assign files to tracks, one file per track.
 *
 * Pass 1: exact disc+track from tags. Pass 2: track number from the file name or
 * a tag-less file. Pass 3: title equality. Anything left is unmatched.
 */
export function matchFilesToTracks(
	files: AudioFileRef[],
	tracks: TrackRef[]
): { matches: Array<{ file: AudioFileRef; trackId: string }>; unmatched: AudioFileRef[] } {
	const remaining = new Map(tracks.map((track) => [track.id, track]));
	const matches: Array<{ file: AudioFileRef; trackId: string }> = [];
	const unmatched: AudioFileRef[] = [];

	const take = (file: AudioFileRef, predicate: (track: TrackRef) => boolean): boolean => {
		for (const track of remaining.values()) {
			if (predicate(track)) {
				matches.push({ file, trackId: track.id });
				remaining.delete(track.id);
				return true;
			}
		}
		return false;
	};

	const pending: AudioFileRef[] = [];
	for (const file of files) {
		const disc = file.discNumber ?? 1;
		const numbers = file.trackNumber ?? parseFileName(file.fileName).trackNumber;
		if (
			numbers === null ||
			!take(file, (t) => (t.discNumber ?? 1) === disc && t.trackNumber === numbers)
		) {
			pending.push(file);
		}
	}

	const stillPending: AudioFileRef[] = [];
	for (const file of pending) {
		const title = file.title ?? parseFileName(file.fileName).title;
		const normalized = title ? normalizeForMatch(title) : '';
		if (!normalized || !take(file, (t) => normalizeForMatch(t.title) === normalized)) {
			stillPending.push(file);
		}
	}

	unmatched.push(...stillPending);
	return { matches, unmatched };
}
