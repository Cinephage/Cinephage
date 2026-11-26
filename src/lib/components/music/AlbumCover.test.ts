// @vitest-environment jsdom
/**
 * The cover tile must never leave the browser's broken-image glyph on screen:
 * `hasCover` is optimistic (a MusicBrainz release the Cover Art Archive may know),
 * so a 404 is a normal answer for a stream-backed album.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';

import AlbumCover from './AlbumCover.svelte';

const coverImage = () => document.querySelector('img');

afterEach(() => {
	cleanup();
});

describe('AlbumCover', () => {
	it('requests the cover when the album has artwork', () => {
		render(AlbumCover, { props: { albumId: 'album-1', hasCover: true, alt: 'Discovery' } });

		const image = coverImage();
		expect(image?.getAttribute('src')).toBe('/api/music/albums/album-1/cover');
		expect(image?.getAttribute('alt')).toBe('Discovery');
	});

	it('renders the disc icon without requesting anything when there is no cover', () => {
		render(AlbumCover, { props: { albumId: 'album-2', hasCover: false } });

		expect(coverImage()).toBeNull();
		expect(document.querySelector('svg')).not.toBeNull();
	});

	it('falls back to the icon when the cover 404s', async () => {
		render(AlbumCover, { props: { albumId: 'album-3', hasCover: true } });

		const image = coverImage();
		expect(image).not.toBeNull();
		await fireEvent.error(image!);

		expect(coverImage()).toBeNull();
		expect(document.querySelector('svg')).not.toBeNull();
	});
});
