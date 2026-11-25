import { describe, expect, it } from 'vitest';
import { groupAudioFiles, normalizeMusicName, type TaggedAudioFile } from './audio-folder.js';

function audioFile(
	absolutePath: string,
	overrides: Partial<TaggedAudioFile> = {}
): TaggedAudioFile {
	const fileName = absolutePath.split('/').pop() ?? 'track.flac';
	return {
		absolutePath,
		relativePath: fileName,
		fileName,
		sizeBytes: 30_000_000,
		discNumber: null,
		trackNumber: null,
		title: null,
		album: null,
		albumArtist: null,
		artist: null,
		year: null,
		format: 'FLAC',
		bitrateKbps: null,
		bitDepth: 16,
		sampleRateHz: 44100,
		channels: 2,
		durationSeconds: 200,
		...overrides
	};
}

describe('normalizeMusicName', () => {
	it('ignores case, accents and punctuation', () => {
		expect(normalizeMusicName('Björk — Homogénic (Live!)')).toBe('bjork homogenic live');
	});

	it('returns an empty key for nothing usable', () => {
		expect(normalizeMusicName(null)).toBe('');
		expect(normalizeMusicName('  ---  ')).toBe('');
	});
});

describe('groupAudioFiles', () => {
	it('keeps a multi-disc album in one group based on its tags', () => {
		const groups = groupAudioFiles([
			audioFile('/m/Artist/Album (2001)/CD1/01 - One.flac', {
				album: 'Album',
				albumArtist: 'Artist',
				year: 2001,
				discNumber: 1,
				trackNumber: 1
			}),
			audioFile('/m/Artist/Album (2001)/CD2/01 - Two.flac', {
				album: 'Album',
				albumArtist: 'Artist',
				year: 2001,
				discNumber: 2,
				trackNumber: 1
			})
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0].folder).toBe('/m/Artist/Album (2001)');
		expect(groups[0].files).toHaveLength(2);
		expect(groups[0].album).toBe('Album');
		expect(groups[0].artist).toBe('Artist');
		expect(groups[0].year).toBe(2001);
	});

	it('treats a nested folder named after the album as one album, not a second one', () => {
		const groups = groupAudioFiles([
			audioFile('/m/Daft Punk/Discovery (2001)/Discovery/01 One More Time.flac', {
				album: 'Discovery',
				albumArtist: 'Daft Punk',
				year: 2001
			}),
			audioFile('/m/Daft Punk/Discovery (2001)/Discovery/02 Aerodynamic.flac', {
				album: 'Discovery',
				albumArtist: 'Daft Punk',
				year: 2001
			})
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0].folder).toBe('/m/Daft Punk/Discovery (2001)/Discovery');
		expect(groups[0].files).toHaveLength(2);
	});

	it('falls back to the folder name when nothing is tagged', () => {
		const groups = groupAudioFiles([
			audioFile('/m/Portishead/Dummy (1994)/01 Mysterons.flac'),
			audioFile('/m/Portishead/Dummy (1994)/02 Sour Times.flac')
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0].folder).toBe('/m/Portishead/Dummy (1994)');
		expect(groups[0].album).toBe('Dummy');
		expect(groups[0].artist).toBe('Portishead');
	});

	it('walks out of a disc folder when the files carry no tags', () => {
		const groups = groupAudioFiles([audioFile('/m/Artist/Album (2000)/CD1/01 Track.flac')]);

		expect(groups).toHaveLength(1);
		expect(groups[0].folder).toBe('/m/Artist/Album (2000)');
		expect(groups[0].album).toBe('Album');
		expect(groups[0].artist).toBe('Artist');
	});

	it('names a mixed-artist album Various Artists instead of splitting it', () => {
		const groups = groupAudioFiles([
			audioFile('/m/Compilations/Now 50/01 A Song.flac', { album: 'Now 50', artist: 'Artist A' }),
			audioFile('/m/Compilations/Now 50/02 B Song.flac', { album: 'Now 50', artist: 'Artist B' })
		]);

		expect(groups).toHaveLength(1);
		expect(groups[0].artist).toBe('Various Artists');
		expect(groups[0].files).toHaveLength(2);
	});

	it('does not merge two albums that share a title in different folders', () => {
		const groups = groupAudioFiles([
			audioFile('/m/A/Live/01 Song.flac', { album: 'Live', albumArtist: 'A', year: 2001 }),
			audioFile('/m/B/Live/01 Song.flac', { album: 'Live', albumArtist: 'B', year: 2001 })
		]);

		expect(groups).toHaveLength(2);
	});
});
