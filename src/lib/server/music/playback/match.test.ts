import { describe, it, expect } from 'vitest';
import { normalizeTitle, pickBestCandidate, type YoutubeCandidate } from './match.js';

/** Titles measured from a live `ytsearch5:` for Aphex Twin — Avril 14th. */
const avrilCandidates: YoutubeCandidate[] = [
	{ id: 'uxTdTaNIUxo', title: 'Avril 14th', duration: 126, channel: 'Aphex Twin' },
	{ id: 'MBFXJw7n-fU', title: 'Aphex Twin - Avril 14th', duration: 122, channel: 'ypeke' },
	{
		id: '97FBWB4vv3s',
		title: 'Aphex Twin – Avril 14th | Josh Cohen (Solo Piano)',
		duration: 130,
		channel: 'Josh Cohen'
	},
	{ id: '4OqqUDqDdJ8', title: 'Avril 14th for 1 Hour', duration: 3631, channel: 'Matthew MacCarthy' }
];

describe('normalizeTitle', () => {
	it('strips bracketed noise, punctuation and diacritics', () => {
		expect(normalizeTitle('Sigur Rós – Hoppípolla (Official Video) [HD]')).toBe(
			'sigur ros hoppipolla'
		);
	});
});

describe('pickBestCandidate', () => {
	it('picks the official upload, not the first result or the cover', () => {
		const best = pickBestCandidate(avrilCandidates, {
			title: 'Avril 14th',
			artist: 'Aphex Twin',
			duration: 126
		});

		expect(best?.id).toBe('uxTdTaNIUxo');
	});

	it('rejects a live version of a studio track (duration drift)', () => {
		// Measured: ytsearch's top hit for Big Thief "Not" was the live session,
		// 302s against the studio track's 367s.
		const best = pickBestCandidate(
			[
				{
					id: 'live',
					title: 'Big Thief - “Not” (Live at The Bunker Studio)',
					duration: 302,
					channel: 'Big Thief'
				}
			],
			{ title: 'Not', artist: 'Big Thief', duration: 367 }
		);

		expect(best).toBeNull();
	});

	it('rejects a different song by the same artist', () => {
		const best = pickBestCandidate(
			[{ id: 'other', title: 'Human After All', duration: 307, channel: 'Daft Punk' }],
			{ title: 'Discovery', artist: 'Daft Punk', duration: 61 }
		);

		expect(best).toBeNull();
	});

	it('prefers the label Topic channel over a cover at the same duration', () => {
		const best = pickBestCandidate(
			[
				{ id: 'cover', title: 'Avril 14th (piano cover)', duration: 126, channel: 'Some Pianist' },
				{ id: 'topic', title: 'Avril 14th', duration: 126, channel: 'Aphex Twin - Topic' }
			],
			{ title: 'Avril 14th', artist: 'Aphex Twin', duration: 126 }
		);

		expect(best?.id).toBe('topic');
	});
});
