// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import CommonOptions from './CommonOptions.svelte';
import type { RootFolderWithSpaceAndDefault as RootFolder } from '#lib/types/downloadClient.js';

const rootFolders: RootFolder[] = [
	{
		id: 'root-a',
		name: 'Movies dir',
		path: '/mnt/movies',
		mediaType: 'movie',
		mediaSubType: 'standard',
		freeSpaceBytes: 1000,
		isDefault: true,
		readOnly: false,
		defaultMonitored: true
	}
];

const scoringProfiles = [{ id: 'qp-any', name: 'Any', description: '', isBuiltIn: true }];

function renderOptions(props: {
	wantsSubtitles: boolean;
	effectiveSubtitleProfile?: {
		profile: { id: string; name: string };
		source: 'movie' | 'series' | 'library' | 'default';
	} | null;
}) {
	return render(CommonOptions, {
		props: {
			mediaType: 'movie',
			rootFolders,
			scoringProfiles,
			selectedRootFolder: 'root-a',
			selectedScoringProfile: 'qp-any',
			searchOnAdd: true,
			...props
		}
	});
}

describe('CommonOptions effective subtitle profile display (add flow)', () => {
	afterEach(() => {
		cleanup();
	});

	it('renders the effective profile line with its inherited source', () => {
		renderOptions({
			wantsSubtitles: true,
			effectiveSubtitleProfile: {
				profile: { id: 'lp-en', name: 'English Only' },
				source: 'default'
			}
		});

		expect(screen.getByText(/Subtitles: English Only \(Inherited: default\)/)).toBeTruthy();
	});

	it('renders nothing extra when subtitles are disabled but no default exists', () => {
		renderOptions({ wantsSubtitles: false, effectiveSubtitleProfile: null });

		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.queryByText(/no default subtitle profile/i)).toBeNull();
	});

	it('warns when subtitles are enabled but no default profile exists', async () => {
		renderOptions({ wantsSubtitles: false, effectiveSubtitleProfile: null });

		const toggles = screen.getAllByRole('checkbox');
		// Second toggle is "auto-download subtitles" (first is search-on-add).
		await fireEvent.click(toggles[1]);

		const status = await screen.findByRole('status');
		expect(status.textContent).toMatch(/no default language profile is configured/i);
	});

	it('renders neither the line nor the warning while the endpoint is still loading', () => {
		renderOptions({ wantsSubtitles: true, effectiveSubtitleProfile: undefined });

		expect(screen.queryByText(/Subtitles:/)).toBeNull();
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('shows the profile line after enabling subtitles with a default present', async () => {
		renderOptions({
			wantsSubtitles: false,
			effectiveSubtitleProfile: {
				profile: { id: 'lp-en', name: 'English Only' },
				source: 'default'
			}
		});

		const toggles = screen.getAllByRole('checkbox');
		await fireEvent.click(toggles[1]);

		expect(await screen.findByText(/Subtitles: English Only \(Inherited: default\)/)).toBeTruthy();
	});
});
