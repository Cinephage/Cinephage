// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import SeriesEditModal, { type SeriesEditData } from './SeriesEditModal.svelte';

vi.mock('#lib/api/settings.js', () => ({
	getLibraryClassificationSettings: vi.fn().mockResolvedValue({})
}));

vi.mock('#lib/api/discover.js', () => ({
	getTmdb: vi.fn().mockResolvedValue(null)
}));

vi.mock('#lib/api/library.js', () => ({
	getSeriesEpisodeGroups: vi.fn().mockResolvedValue([])
}));

vi.mock('#lib/stores/toast.svelte.js', () => ({
	toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}));

const qualityProfiles = [
	{ id: 'balanced', name: 'Balanced', description: '', isBuiltIn: true, isDefault: true },
	{ id: 'hq', name: 'HQ', description: '', isBuiltIn: false, isDefault: false }
];

interface SeriesFixture {
	tmdbId: number;
	title: string;
	year: number | null;
	monitored: boolean;
	scoringProfileId: string | null;
	rootFolderId: string;
	episodeFileCount: number;
	seasonFolder: boolean;
	wantsSubtitles: boolean;
	seriesType: string;
	path: string;
	episodeGroupId: string | null;
	id: string;
	languageProfileId?: string | null;
	metadataLanguageMode?: 'inherit' | 'original' | 'explicit' | null;
	metadataLanguageValue?: string | null;
	metadataLanguage?: string | null;
	preferOriginalTitle: boolean;
}

function makeSeries(overrides: Partial<SeriesFixture> = {}): SeriesFixture {
	return {
		tmdbId: 222,
		title: 'Example Series',
		year: 2018,
		monitored: true,
		scoringProfileId: null,
		rootFolderId: 'root-a',
		episodeFileCount: 0,
		seasonFolder: true,
		wantsSubtitles: true,
		seriesType: 'standard',
		path: 'Example Series (2018)',
		episodeGroupId: null,
		id: 'series-1',
		languageProfileId: null,
		metadataLanguageMode: 'inherit',
		metadataLanguageValue: null,
		metadataLanguage: null,
		preferOriginalTitle: false,
		...overrides
	};
}

const languageProfiles = [
	{ id: 'lp-en', name: 'English Only' },
	{ id: 'lp-jp', name: 'Japanese + English' }
];

function renderModal(
	onSave: (data: SeriesEditData) => void,
	series = makeSeries(),
	options: {
		effectiveLanguageProfile?: {
			profile: { id: string; name: string };
			source: 'movie' | 'series' | 'library' | 'default';
		} | null;
	} = {}
) {
	return render(SeriesEditModal, {
		props: {
			open: true,
			series,
			qualityProfiles,
			languageProfiles,
			effectiveLanguageProfile: options.effectiveLanguageProfile ?? null,
			delayProfiles: [],
			rootFolders: [],
			saving: false,
			onClose: vi.fn(),
			onSave
		}
	});
}

describe('SeriesEditModal quality profile persistence (issue #493)', () => {
	let onSave: (data: SeriesEditData) => void;

	beforeEach(() => {
		onSave = vi.fn<(data: SeriesEditData) => void>();
	});

	afterEach(() => {
		cleanup();
	});

	it('persists the default scoring profile id when explicitly selected', async () => {
		renderModal(onSave);

		const select = screen.getByRole('combobox', { name: /quality profile/i }) as HTMLSelectElement;
		fireEvent.change(select, { target: { value: 'balanced' } });
		expect(select.value).toBe('balanced');

		await fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ scoringProfileId: 'balanced' }));
	});

	it('keeps null when the default profile was not explicitly changed', async () => {
		renderModal(onSave);

		await fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ scoringProfileId: null }));
	});
});

describe('SeriesEditModal metadata language mode/value', () => {
	let onSave: (data: SeriesEditData) => void;

	beforeEach(() => {
		onSave = vi.fn<(data: SeriesEditData) => void>();
	});

	afterEach(() => {
		cleanup();
	});

	it('disables the locale input unless the explicit mode is selected', async () => {
		renderModal(
			onSave,
			makeSeries({ metadataLanguageMode: 'inherit', metadataLanguageValue: null })
		);

		const modeSelect = screen.getByRole('combobox', {
			name: /^metadata language$/i
		}) as HTMLSelectElement;
		const localeSelect = screen.getByRole('combobox', { name: /^locale$/i }) as HTMLSelectElement;

		expect(modeSelect.value).toBe('inherit');
		expect(localeSelect.disabled).toBe(true);

		await fireEvent.change(modeSelect, { target: { value: 'explicit' } });
		expect(localeSelect.disabled).toBe(false);

		await fireEvent.change(modeSelect, { target: { value: 'original' } });
		expect(localeSelect.disabled).toBe(true);
	});

	it('sends the explicit pair with the chosen locale', async () => {
		renderModal(
			onSave,
			makeSeries({ metadataLanguageMode: 'inherit', metadataLanguageValue: null })
		);

		const modeSelect = screen.getByRole('combobox', {
			name: /^metadata language$/i
		}) as HTMLSelectElement;
		const localeSelect = screen.getByRole('combobox', { name: /^locale$/i }) as HTMLSelectElement;

		await fireEvent.change(modeSelect, { target: { value: 'explicit' } });
		await fireEvent.change(localeSelect, { target: { value: 'es-ES' } });
		await fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				metadataLanguageMode: 'explicit',
				metadataLanguageValue: 'es-ES'
			})
		);
	});

	it('sends a null value for inherit and original modes', async () => {
		renderModal(
			onSave,
			makeSeries({ metadataLanguageMode: 'explicit', metadataLanguageValue: 'de-DE' })
		);

		const modeSelect = screen.getByRole('combobox', {
			name: /^metadata language$/i
		}) as HTMLSelectElement;
		await fireEvent.change(modeSelect, { target: { value: 'original' } });
		await fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ metadataLanguageMode: 'original', metadataLanguageValue: null })
		);
	});

	it('falls back to the legacy metadataLanguage field when the pair is absent', async () => {
		renderModal(
			onSave,
			makeSeries({
				metadataLanguageMode: undefined,
				metadataLanguageValue: undefined,
				metadataLanguage: 'ko-KR'
			})
		);

		const modeSelect = screen.getByRole('combobox', {
			name: /^metadata language$/i
		}) as HTMLSelectElement;
		const localeSelect = screen.getByRole('combobox', { name: /^locale$/i }) as HTMLSelectElement;

		expect(modeSelect.value).toBe('explicit');
		expect(localeSelect.disabled).toBe(false);
		expect(localeSelect.value).toBe('ko-KR');

		await fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ metadataLanguageMode: 'explicit', metadataLanguageValue: 'ko-KR' })
		);
	});
});

describe('SeriesEditModal subtitle profile inheritance', () => {
	let onSave: (data: SeriesEditData) => void;

	beforeEach(() => {
		onSave = vi.fn<(data: SeriesEditData) => void>();
	});

	afterEach(() => {
		cleanup();
	});

	it('shows the inherited effective profile and its source when no override is set', async () => {
		renderModal(onSave, makeSeries(), {
			effectiveLanguageProfile: {
				profile: { id: 'lp-en', name: 'English Only' },
				source: 'library'
			}
		});

		expect(await screen.findByText(/Inherited: English Only \(library\)/)).toBeTruthy();

		const select = screen.getByRole('combobox', {
			name: /language profile/i
		}) as HTMLSelectElement;
		expect(select.value).toBe('');
	});

	it('shows "(default)" as the source when resolved from the instance default', async () => {
		renderModal(onSave, makeSeries(), {
			effectiveLanguageProfile: {
				profile: { id: 'lp-en', name: 'English Only' },
				source: 'default'
			}
		});

		expect(await screen.findByText(/Inherited: English Only \(default\)/)).toBeTruthy();
	});

	it('saves the selected profile id as the languageProfileId override', async () => {
		renderModal(onSave, makeSeries(), {
			effectiveLanguageProfile: {
				profile: { id: 'lp-en', name: 'English Only' },
				source: 'library'
			}
		});

		const select = screen.getByRole('combobox', {
			name: /language profile/i
		}) as HTMLSelectElement;
		await fireEvent.change(select, { target: { value: 'lp-jp' } });
		await fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ languageProfileId: 'lp-jp' }));
	});

	it('sends null (clear override) when inherit stays selected', async () => {
		renderModal(onSave, makeSeries({ languageProfileId: 'lp-jp' }), {
			effectiveLanguageProfile: {
				profile: { id: 'lp-en', name: 'English Only' },
				source: 'library'
			}
		});

		const select = screen.getByRole('combobox', {
			name: /language profile/i
		}) as HTMLSelectElement;
		expect(select.value).toBe('lp-jp');

		await fireEvent.change(select, { target: { value: '' } });
		await fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ languageProfileId: null }));
	});
});
