// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import LanguageSettingsForm from './languages/LanguageSettingsForm.svelte';

const { updateLanguageSettings } = vi.hoisted(() => ({
	updateLanguageSettings: vi.fn()
}));

vi.mock('$app/paths', () => ({
	// Mirrors kit's resolve(): pathnames get a leading slash, route IDs pass through.
	resolve: (path: string) => (path.startsWith('/') ? path : `/${path}`)
}));

vi.mock('#lib/api/index.js', () => ({
	updateLanguageSettings,
	ApiError: class ApiError extends Error {}
}));

vi.mock('#lib/stores/toast.svelte.js', () => ({
	toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}));

interface FormSettings {
	defaultProfileId: string | null;
	metadataLocale: string;
	region: string;
	discoverOriginalFilter: string | null;
	unknownSubtitlePolicy: 'und' | 'assume-language';
	assumedLanguage: string | null;
	autoSyncSubtitles: boolean;
	preferOriginalTitle: boolean;
}

const baseSettings: FormSettings = {
	defaultProfileId: 'p1',
	metadataLocale: 'en-US',
	region: 'US',
	discoverOriginalFilter: null,
	unknownSubtitlePolicy: 'und',
	assumedLanguage: null,
	autoSyncSubtitles: true,
	preferOriginalTitle: false
};

const countries = [
	{ code: 'US', name: 'United States' },
	{ code: 'DE', name: 'Germany' }
];

function renderForm(overrides: Partial<FormSettings> = {}) {
	const settings = { ...baseSettings, ...overrides };
	return render(LanguageSettingsForm, {
		props: {
			settings,
			countries,
			dirty: false,
			busy: false,
			saved: false
		}
	});
}

describe('language settings form', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// The server persists the patch and echoes the full settings row back.
		updateLanguageSettings.mockImplementation(async (patch: Partial<FormSettings>) => ({
			...baseSettings,
			...patch
		}));
	});

	afterEach(() => {
		cleanup();
	});

	it('renders the localization and subtitle-handling values without the interface or profile sections', () => {
		const { container } = renderForm({ preferOriginalTitle: true });

		// The per-user interface selector lives in the sidebar, not here.
		expect(container.querySelector('.language-selector')).toBeNull();

		const metadataLocale = screen.getByRole('combobox', {
			name: /metadata language/i
		}) as HTMLSelectElement;
		expect(metadataLocale.value).toBe('en-US');

		const region = screen.getByRole('combobox', { name: /^region$/i }) as HTMLSelectElement;
		expect(region.value).toBe('US');

		const discoverFilter = screen.getByRole('combobox', {
			name: /original-language filter/i
		}) as HTMLSelectElement;
		expect(discoverFilter.value).toBe('');

		const preferOriginal = screen.getByRole('checkbox', {
			name: /show original titles by default/i
		}) as HTMLInputElement;
		expect(preferOriginal.checked).toBe(true);

		// Default-profile selection moved into the profile cards.
		expect(screen.queryByRole('combobox', { name: /default profile/i })).toBeNull();

		const autoSync = screen.getByRole('checkbox', {
			name: /auto-sync subtitles/i
		}) as HTMLInputElement;
		expect(autoSync.checked).toBe(true);
	});

	it('only sends the changed fields on save', async () => {
		const { component } = renderForm();

		const region = screen.getByRole('combobox', { name: /^region$/i }) as HTMLSelectElement;
		await fireEvent.change(region, { target: { value: 'DE' } });
		await component.save();

		expect(updateLanguageSettings).toHaveBeenCalledTimes(1);
		expect(updateLanguageSettings).toHaveBeenCalledWith({ region: 'DE' });
	});

	it('sends an empty patch when nothing changed', async () => {
		const { component } = renderForm();

		await component.save();

		expect(updateLanguageSettings).toHaveBeenCalledWith({});
	});

	it('compares later edits against the saved snapshot, not the stale loader data', async () => {
		const { component } = renderForm();

		const region = screen.getByRole('combobox', { name: /^region$/i }) as HTMLSelectElement;
		await fireEvent.change(region, { target: { value: 'DE' } });
		await component.save();

		// The server stored region=DE, so an immediate second save is a no-op.
		await component.save();

		expect(updateLanguageSettings).toHaveBeenCalledTimes(2);
		expect(updateLanguageSettings).toHaveBeenLastCalledWith({});
	});

	it('keeps the saved value in the form after saving (no stale-prop re-sync)', async () => {
		const { component } = renderForm();

		const checkbox = screen.getByRole('checkbox', {
			name: /show original titles by default/i
		}) as HTMLInputElement;
		await fireEvent.click(checkbox);
		await component.save();

		// The dirty flag flipping back to false must not re-apply the stale
		// loader prop over the just-saved response.
		expect(
			(
				screen.getByRole('checkbox', {
					name: /show original titles by default/i
				}) as HTMLInputElement
			).checked
		).toBe(true);

		await component.save();
		expect(updateLanguageSettings).toHaveBeenLastCalledWith({});
	});

	it('shows the assumed-language select only for the assume-language policy', async () => {
		const { component } = renderForm();

		expect(screen.queryByRole('combobox', { name: /assumed language/i })).toBeNull();

		const policy = screen.getByRole('combobox', {
			name: /unknown subtitle language/i
		}) as HTMLSelectElement;
		await fireEvent.change(policy, { target: { value: 'assume-language' } });

		const assumed = screen.getByRole('combobox', {
			name: /assumed language/i
		}) as HTMLSelectElement;
		expect(assumed).toBeTruthy();

		// Changing the policy alone must not write the assumed language
		await fireEvent.change(assumed, { target: { value: 'de' } });
		await component.save();
		expect(updateLanguageSettings).toHaveBeenCalledTimes(1);
		expect(updateLanguageSettings).toHaveBeenCalledWith({
			unknownSubtitlePolicy: 'assume-language',
			assumedLanguage: 'de'
		});
	});

	it('clears the stored assumed language when switching back to the und policy', async () => {
		const { component } = renderForm({
			unknownSubtitlePolicy: 'assume-language',
			assumedLanguage: 'fr'
		});

		const policy = screen.getByRole('combobox', {
			name: /unknown subtitle language/i
		}) as HTMLSelectElement;
		await fireEvent.change(policy, { target: { value: 'und' } });

		// The select is hidden again and the stored language is cleared on save
		expect(screen.queryByRole('combobox', { name: /assumed language/i })).toBeNull();

		await component.save();
		expect(updateLanguageSettings).toHaveBeenCalledWith({
			unknownSubtitlePolicy: 'und',
			assumedLanguage: null
		});
	});

	it('links to subtitle providers (profiles and naming live in sibling tabs)', () => {
		renderForm();

		expect(screen.getByRole('link', { name: /subtitle providers/i }).getAttribute('href')).toBe(
			'/settings/integrations/subtitle-providers'
		);
		expect(screen.queryByRole('link', { name: /language profiles/i })).toBeNull();
		expect(screen.queryByRole('link', { name: /^naming$/i })).toBeNull();
	});
});
