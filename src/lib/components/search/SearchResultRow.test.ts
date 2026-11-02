// @vitest-environment jsdom
/**
 * SearchResultRow parsed-attribute display (#586).
 *
 * The search API already ships the full parsed release (audio codec and
 * channels, edition, repack/proper flags, languages); these tests pin the
 * row UI actually surfacing them: the audio pill in the collapsed badge row
 * and the Audio Codec / Edition / Version / Languages rows in Technical
 * Details, with Unknown handling when the parser detected nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import SearchResultRow, { type Release } from './SearchResultRow.svelte';

const onGrab = vi.fn().mockResolvedValue(undefined);

function createRelease(overrides: Partial<Release> = {}): Release {
	return {
		guid: 'release-1',
		title: 'Movie.2024.1080p.BluRay.x264-GROUP',
		downloadUrl: 'http://indexer.example/torrent',
		size: 8_000_000_000,
		publishDate: new Date(),
		indexerId: 'indexer-1',
		indexerName: 'Test Indexer',
		protocol: 'torrent',
		...overrides
	};
}

/** Expand the row via the mobile toggle (jsdom renders both layouts). */
async function expandRow() {
	await fireEvent.click(screen.getAllByTitle('Expand details')[0]);
}

describe('SearchResultRow parsed attribute display (#586)', () => {
	it('shows the audio pill and parsed rows when data is present', async () => {
		const release = createRelease({
			parsed: {
				resolution: '1080p',
				source: 'bluray',
				codec: 'h264',
				audioCodec: 'flac',
				audioChannels: '1.0',
				edition: "Director's Cut",
				isRepack: true,
				languages: ['en', 'es']
			}
		});
		render(SearchResultRow, { props: { release, onGrab } });

		// Collapsed: audio codec pill alongside the quality badges.
		expect(screen.getAllByText('FLAC').length).toBeGreaterThan(0);

		await expandRow();

		expect(screen.getByText('Audio Codec')).toBeTruthy();
		expect(screen.getByText('FLAC 1.0')).toBeTruthy();
		expect(screen.getByText('Video Codec')).toBeTruthy();
		expect(screen.getByText("Director's Cut")).toBeTruthy();
		expect(screen.getByText('Repack')).toBeTruthy();
		expect(screen.getByText('en, es')).toBeTruthy();
	});

	it('renders Unknown audio and hides absent rows', async () => {
		const release = createRelease({
			parsed: { resolution: '1080p', source: 'bluray', codec: 'h264' }
		});
		render(SearchResultRow, { props: { release, onGrab } });

		// Collapsed: no audio pill when the codec is unknown.
		expect(screen.queryByText('FLAC')).toBeNull();

		await expandRow();

		// The audio row is always present, with the Unknown fallback.
		expect(screen.getByText('Audio Codec')).toBeTruthy();
		expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);

		// Edition / Version / Languages rows hide when there is nothing to show.
		expect(screen.queryByText('Edition')).toBeNull();
		expect(screen.queryByText('Version')).toBeNull();
		expect(screen.queryByText('Languages')).toBeNull();
	});

	it('combines repack and proper into one version summary', async () => {
		const release = createRelease({
			parsed: { audioCodec: 'dd+', audioChannels: '5.1', hasAtmos: true, isProper: true }
		});
		render(SearchResultRow, { props: { release, onGrab } });

		await expandRow();

		expect(screen.getByText('DD+ 5.1 ATMOS')).toBeTruthy();
		expect(screen.getByText('Proper')).toBeTruthy();
	});

	it('shows channels alone when only channels are known', async () => {
		const release = createRelease({
			parsed: { audioCodec: 'unknown', audioChannels: '5.1' }
		});
		render(SearchResultRow, { props: { release, onGrab } });

		await expandRow();

		// Channels carry the row on their own; no Unknown fallback fires.
		expect(screen.getByText('5.1')).toBeTruthy();
		expect(screen.queryByText('Unknown')).toBeNull();
	});
});

afterEach(() => {
	cleanup();
	onGrab.mockClear();
});
