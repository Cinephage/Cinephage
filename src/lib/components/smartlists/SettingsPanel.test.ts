// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import SettingsPanel from './SettingsPanel.svelte';
import type { RootFolderBasic } from '#lib/types/downloadClient.js';

const scoringProfiles = [{ id: 'balanced', name: 'Balanced' }];

function renderPanel(rootFolders: RootFolderBasic[]) {
	return render(SettingsPanel, {
		props: {
			sortBy: 'popularity.desc',
			itemLimit: 100,
			excludeInLibrary: true,
			refreshIntervalHours: 24,
			autoAddBehavior: 'add_only',
			rootFolderId: '',
			scoringProfileId: '',
			autoAddMonitored: true,
			mediaType: 'movie',
			rootFolders,
			scoringProfiles,
			open: true
		}
	});
}

describe('smart-list settings root-folder destination', () => {
	afterEach(() => cleanup());

	it('offers only writable folders for auto-add destinations', () => {
		renderPanel([
			{ id: 'read-only', path: '/media/archive', mediaType: 'movie', readOnly: true },
			{ id: 'writable', path: '/media/movies', mediaType: 'movie', readOnly: false },
			{ id: 'tv', path: '/media/tv', mediaType: 'tv', readOnly: false }
		]);

		const select = screen.getByRole('combobox', { name: /root folder/i }) as HTMLSelectElement;
		const options = Array.from(select.options);
		expect(options.map((option) => option.value)).toEqual(['', 'writable']);
		expect(screen.getByText('/media/movies')).toBeTruthy();
		expect(screen.queryByText('/media/archive')).toBeNull();
	});

	it('explains when no writable folder exists for the media type', () => {
		renderPanel([
			{ id: 'read-only', path: '/media/archive', mediaType: 'movie', readOnly: true },
			{ id: 'tv', path: '/media/tv', mediaType: 'tv', readOnly: false }
		]);

		expect(screen.getByText('No writable movie root folders configured.')).toBeTruthy();
	});
});
