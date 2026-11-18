import { describe, it, expect } from 'vitest';
import { matchFilesToTracks, normalizeForMatch, parseFileName } from './track-matching.js';

const tracks = [
	{ id: 't1', discNumber: 1, trackNumber: 1, title: 'One More Time' },
	{ id: 't2', discNumber: 1, trackNumber: 2, title: 'Aerodynamic' },
	{ id: 't3', discNumber: 1, trackNumber: 3, title: 'Digital Love' },
	{ id: 't4', discNumber: 2, trackNumber: 1, title: 'Bonus Track' }
];

describe('parseFileName', () => {
	it('reads a numbered file name', () => {
		expect(parseFileName('01 - One More Time.flac')).toEqual({
			trackNumber: 1,
			title: 'One More Time'
		});
		expect(parseFileName('02. Aerodynamic.mp3')).toEqual({
			trackNumber: 2,
			title: 'Aerodynamic'
		});
	});

	it('ignores an unnumbered name', () => {
		expect(parseFileName('Digital Love.flac')).toEqual({
			trackNumber: null,
			title: 'Digital Love'
		});
	});
});

describe('normalizeForMatch', () => {
	it('ignores case, punctuation and accents', () => {
		expect(normalizeForMatch('Beyoncé — Halo!')).toBe('beyonce halo');
	});
});

describe('matchFilesToTracks', () => {
	it('matches by disc and track number from tags', () => {
		const { matches, unmatched } = matchFilesToTracks(
			[
				{ discNumber: 1, trackNumber: 3, title: 'Digital Love', fileName: 'any.flac' },
				{ discNumber: 2, trackNumber: 1, title: 'Bonus Track', fileName: 'any2.flac' }
			],
			tracks
		);

		expect(matches).toEqual([
			{ file: expect.objectContaining({ trackNumber: 3 }), trackId: 't3' },
			{ file: expect.objectContaining({ discNumber: 2 }), trackId: 't4' }
		]);
		expect(unmatched).toHaveLength(0);
	});

	it('falls back to the number in the file name when tags are empty', () => {
		const { matches } = matchFilesToTracks(
			[{ discNumber: null, trackNumber: null, title: null, fileName: '02 - Aerodynamic.flac' }],
			tracks
		);

		expect(matches.map((match) => match.trackId)).toEqual(['t2']);
	});

	it('falls back to the title when there is no usable number', () => {
		const { matches } = matchFilesToTracks(
			[{ discNumber: null, trackNumber: null, title: 'digital love', fileName: 'x.flac' }],
			tracks
		);

		expect(matches.map((match) => match.trackId)).toEqual(['t3']);
	});

	it('never assigns one track to two files and keeps extras as unmatched', () => {
		const { matches, unmatched } = matchFilesToTracks(
			[
				{ discNumber: 1, trackNumber: 1, title: 'One More Time', fileName: 'a.flac' },
				{ discNumber: 1, trackNumber: 1, title: 'One More Time', fileName: 'b.flac' },
				{ discNumber: null, trackNumber: null, title: 'Interview', fileName: 'c.flac' }
			],
			tracks
		);

		// One track, one file: the second copy is an extra file of the album, kept
		// and copied, but it is not another copy of the track.
		expect(matches).toHaveLength(1);
		expect(matches[0].trackId).toBe('t1');
		expect(unmatched.map((file) => file.fileName)).toEqual(['b.flac', 'c.flac']);
	});
});
