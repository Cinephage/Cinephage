/**
 * Audio files as the music importer sees them.
 *
 * Three things must be identical whether an album arrives by download or is
 * adopted from a library folder: which extensions count, what a file's tags
 * say, and where one album's files begin and end. They live here once so the
 * importer and the disk scanner cannot drift apart — a file imported by one
 * and invisible to the other is a duplicate, not a missing scan.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { createChildLogger } from '#lib/logging/index.js';

const logger = createChildLogger({ module: 'MusicAudioFolder', logDomain: 'imports' });

export const AUDIO_EXTENSIONS = new Set([
	'.flac',
	'.mp3',
	'.m4a',
	'.aac',
	'.ogg',
	'.opus',
	'.wav',
	'.wv',
	'.ape'
]);

/** Directories and files that are never album content. */
export const SKIP_NAMES = /^(samples?|scans|covers?|artwork)$|^\./i;
/** A file this small is a cue stub or a failed download, not audio. */
export const MIN_AUDIO_BYTES = 64 * 1024;
/** Deeper nesting than this is a box set's paperwork, not its audio. */
const MAX_DEPTH = 4;
/** A disc folder belongs to the album folder above it. */
const DISC_FOLDER = /^(cd|disc|disk)[\s._-]*\d+$/i;

export interface TaggedAudioFile {
	absolutePath: string;
	/** Path relative to the folder being walked; unique within that folder. */
	relativePath: string;
	fileName: string;
	sizeBytes: number;
	discNumber: number | null;
	trackNumber: number | null;
	title: string | null;
	album: string | null;
	albumArtist: string | null;
	artist: string | null;
	year: number | null;
	format: string | null;
	bitrateKbps: number | null;
	bitDepth: number | null;
	sampleRateHz: number | null;
	channels: number | null;
	durationSeconds: number | null;
}

/** One album's worth of files, wherever they sit under a library root. */
export interface AudioAlbumFolder {
	/** Absolute folder the album's relative paths are based on. */
	folder: string;
	files: TaggedAudioFile[];
	album: string | null;
	artist: string | null;
	year: number | null;
}

/** Every audio file under a folder, tagged. Hidden and scan folders skipped. */
export async function collectAudioFiles(
	root: string,
	current: string = root,
	depth = 0
): Promise<TaggedAudioFile[]> {
	if (depth > MAX_DEPTH) return [];

	const entries = await fs.readdir(current, { withFileTypes: true });
	const files: TaggedAudioFile[] = [];

	for (const entry of entries) {
		if (SKIP_NAMES.test(entry.name)) continue;
		const full = path.join(current, entry.name);

		if (entry.isDirectory()) {
			files.push(...(await collectAudioFiles(root, full, depth + 1)));
			continue;
		}
		if (!AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;

		const stats = await fs.stat(full).catch(() => null);
		if (!stats || stats.size < MIN_AUDIO_BYTES) continue;

		files.push(await readAudioTags(full, path.relative(root, full), entry.name, stats.size));
	}

	return files;
}

export async function readAudioTags(
	absolutePath: string,
	relativePath: string,
	fileName: string,
	sizeBytes: number
): Promise<TaggedAudioFile> {
	const base: TaggedAudioFile = {
		absolutePath,
		relativePath,
		fileName,
		sizeBytes,
		discNumber: null,
		trackNumber: null,
		title: null,
		album: null,
		albumArtist: null,
		artist: null,
		year: null,
		format: null,
		bitrateKbps: null,
		bitDepth: null,
		sampleRateHz: null,
		channels: null,
		durationSeconds: null
	};

	try {
		const metadata = await parseFile(absolutePath, { duration: true, skipCovers: true });
		const { common, format } = metadata;
		return {
			...base,
			discNumber: common.disk?.no ?? null,
			trackNumber: common.track?.no ?? null,
			title: common.title ?? null,
			album: common.album ?? null,
			albumArtist: common.albumartist ?? null,
			artist: common.artist ?? null,
			year: common.year ?? null,
			format: format.container ?? format.codec ?? null,
			bitrateKbps: format.bitrate ? Math.round(format.bitrate / 1000) : null,
			bitDepth: format.bitsPerSample ?? null,
			sampleRateHz: format.sampleRate ?? null,
			channels: format.numberOfChannels ?? null,
			durationSeconds: format.duration ? Math.round(format.duration) : null
		};
	} catch (error) {
		// An unreadable tag block must not lose the file: the matcher falls back
		// to the file name, which is what it does when tags are absent anyway.
		logger.warn(
			{ file: fileName, err: error instanceof Error ? error.message : String(error) },
			'[MusicImport] could not read tags'
		);
		return base;
	}
}

/** Case- and accent-insensitive comparison key. */
export function normalizeMusicName(value: string | null | undefined): string {
	return (value ?? '')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/** The value most files in a group agree on; ties go to the first seen. */
function mostCommon(values: Array<string | number | null>): string | number | null {
	const counts = new Map<string, { value: string | number; count: number }>();
	for (const value of values) {
		if (value === null || value === '') continue;
		const key = String(value);
		const current = counts.get(key);
		if (current) current.count += 1;
		else counts.set(key, { value, count: 1 });
	}
	let best: { value: string | number; count: number } | null = null;
	for (const entry of counts.values()) {
		if (!best || entry.count > best.count) best = entry;
	}
	return best?.value ?? null;
}

/** Lowest common ancestor of a group's files. */
function commonFolder(files: TaggedAudioFile[]): string {
	const folders = files.map((file) => path.dirname(file.absolutePath));
	let shared = folders[0].split(path.sep);
	for (const folder of folders.slice(1)) {
		const parts = folder.split(path.sep);
		let index = 0;
		while (index < shared.length && index < parts.length && shared[index] === parts[index]) index += 1;
		shared = shared.slice(0, index);
	}
	return shared.join(path.sep) || path.sep;
}

/** Album and artist a folder name implies when the tags are silent. */
function inferFromFolder(folder: string): { album: string | null; artist: string | null } {
	let name = path.basename(folder);
	let parent = path.dirname(folder);
	// A disc folder names a disc, not the album.
	if (DISC_FOLDER.test(name)) {
		name = path.basename(parent);
		parent = path.dirname(parent);
	}
	// Strip a trailing year: "Discovery (2001)" and "Discovery [2001]" both
	// name the same album, and MusicBrainz wants the plain title.
	const album = name.replace(/\s*[([〔]\s*(19|20)\d{2}\s*[)\]〕]\s*$/, '').trim() || null;
	const artist = path.basename(parent).trim() || null;
	return { album, artist };
}

/**
 * Split a walk into albums.
 *
 * Tags are the primary signal, because a library folder can hold disc
 * subfolders, bonus tracks and a nested copy of the album name and still be
 * one album. Files with no album tag fall back to their folder, which is the
 * shape a hand-made drop usually takes.
 */
export function groupAudioFiles(files: TaggedAudioFile[]): AudioAlbumFolder[] {
	const tagged = new Map<string, TaggedAudioFile[]>();
	const untagged = new Map<string, TaggedAudioFile[]>();

	for (const file of files) {
		if (file.album?.trim()) {
			// A missing album-artist means a compilation: per-track artists must
			// not split one album into five. The album title alone groups it.
			const key = [
				normalizeMusicName(file.albumArtist ?? '*'),
				normalizeMusicName(file.album),
				file.year ?? ''
			].join('\u0000');
			const bucket = tagged.get(key);
			if (bucket) bucket.push(file);
			else tagged.set(key, [file]);
		} else {
			const folder = DISC_FOLDER.test(path.basename(path.dirname(file.absolutePath)))
				? path.dirname(path.dirname(file.absolutePath))
				: path.dirname(file.absolutePath);
			const bucket = untagged.get(folder);
			if (bucket) bucket.push(file);
			else untagged.set(folder, [file]);
		}
	}

	const groups: AudioAlbumFolder[] = [];

	for (const bucket of tagged.values()) {
		const folder = commonFolder(bucket);
		const inferred = inferFromFolder(folder);
		const year = mostCommon(bucket.map((file) => file.year));

		// Album artist, then the one track artist they agree on, then the folder.
		// Mixed track artists with no album-artist tag is a compilation, and
		// saying so is what lets the match search MusicBrainz without an artist.
		let artist = mostCommon(bucket.map((file) => file.albumArtist)) as string | null;
		if (!artist) {
			const distinct = new Set(
				bucket.map((file) => normalizeMusicName(file.artist)).filter((name) => name.length > 0)
			);
			if (distinct.size > 1) artist = 'Various Artists';
			else artist = (mostCommon(bucket.map((file) => file.artist)) as string | null) ?? inferred.artist;
		}

		groups.push({
			folder,
			files: bucket,
			album: (mostCommon(bucket.map((file) => file.album)) as string | null) ?? inferred.album,
			artist,
			year: typeof year === 'number' ? year : null
		});
	}

	for (const [folder, bucket] of untagged) {
		const inferred = inferFromFolder(folder);
		groups.push({
			folder,
			files: bucket,
			album: inferred.album,
			artist: inferred.artist,
			year: (mostCommon(bucket.map((file) => file.year)) as number | null) ?? null
		});
	}

	return groups.sort((a, b) => a.folder.localeCompare(b.folder));
}
