// @vitest-environment jsdom
/**
 * Poster tags use the shared look from `poster-tags.ts`: their text sits in its
 * own span (trimmed to the capital letters, so it is centred in the tag), and a
 * series' episode count is short enough to fit a phone poster's corner.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import LibraryMediaCard from './LibraryMediaCard.svelte';
import type { MediaCardView } from './media-view.js';
import { POSTER_TAG_TEXT } from '#lib/components/ui/poster-tags.js';

afterEach(cleanup);

const series: MediaCardView = {
	id: 'series-1',
	kind: 'tv',
	href: '/library/tv/series-1',
	title: 'Example Series',
	year: 2013,
	art: null,
	square: false,
	typeLabel: 'TV Show',
	typeTone: 'secondary',
	monitored: true,
	hideMonitored: false,
	partiallyMonitored: false,
	state: { icon: 'count', label: '81 of 91 episodes', short: '81/91', tone: 'neutral' },
	detail: null,
	progress: 89,
	subtitle: null,
	tag: null
};

describe('LibraryMediaCard poster tags', () => {
	it('shows the short episode count and keeps the full one as the title', () => {
		render(LibraryMediaCard, { props: { view: series } });

		const count = screen.getByText('81/91');
		expect(count.closest('[title]')?.getAttribute('title')).toBe('81 of 91 episodes');
		expect(screen.queryByText('81 of 91 episodes')).toBeNull();
	});

	it('puts every tag text in the shared, centred text span', () => {
		render(LibraryMediaCard, { props: { view: series } });

		for (const text of ['81/91', 'TV Show']) {
			expect(screen.getByText(text).className).toBe(POSTER_TAG_TEXT);
		}
	});
});
