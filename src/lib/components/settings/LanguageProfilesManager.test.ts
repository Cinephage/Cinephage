// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/svelte';
import LanguageProfilesManager from './languages/LanguageProfilesManager.svelte';
import type { SubtitleRequirement } from '#lib/shared/language-profile.js';

const {
	createLanguageProfile,
	updateLanguageProfile,
	deleteLanguageProfile,
	updateLanguageSettings,
	refreshAll
} = vi.hoisted(() => ({
	createLanguageProfile: vi.fn().mockResolvedValue({ success: true }),
	updateLanguageProfile: vi.fn().mockResolvedValue({ success: true }),
	deleteLanguageProfile: vi.fn().mockResolvedValue({ success: true }),
	updateLanguageSettings: vi.fn().mockResolvedValue({}),
	refreshAll: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('$app/navigation', () => ({ refreshAll }));

vi.mock('#lib/api/index.js', () => ({
	createLanguageProfile,
	updateLanguageProfile,
	deleteLanguageProfile,
	updateLanguageSettings,
	ApiError: class ApiError extends Error {}
}));

vi.mock('#lib/stores/toast.svelte.js', () => ({
	toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}));

type FixtureProfile = {
	id: string;
	name: string;
	audio: { preferOriginal: boolean; languages: string[]; mode: 'prefer' | 'require' };
	subtitles: SubtitleRequirement[];
	cutoffRank: number | null;
	minimumScore: number;
	upgradesAllowed: boolean;
};

const profiles: FixtureProfile[] = [
	{
		id: 'p1',
		name: 'English',
		audio: { preferOriginal: true, languages: [], mode: 'prefer' as const },
		subtitles: [{ tag: 'en', variant: 'regular' as const, accessibility: 'any' as const }],
		cutoffRank: null,
		minimumScore: 70,
		upgradesAllowed: true
	},
	{
		id: 'p2',
		name: 'French',
		audio: { preferOriginal: true, languages: ['fr'], mode: 'prefer' as const },
		subtitles: [{ tag: 'fr', variant: 'forced' as const, accessibility: 'require-hi' as const }],
		cutoffRank: 0,
		minimumScore: 80,
		upgradesAllowed: false
	}
];

function renderManager(defaultProfileId: string | null) {
	return render(LanguageProfilesManager, { props: { profiles, defaultProfileId } });
}

describe('language profiles manager', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it('marks the default profile via the defaultProfileId prop', () => {
		renderManager('p2');

		const badge = screen.getByText('Default');
		expect(badge.closest('h3')?.textContent).toContain('French');
	});

	it('only offers the set-default action on non-default profiles and saves it instantly', async () => {
		renderManager('p2');

		const setDefaultButtons = screen.getAllByRole('button', { name: 'Set as default' });
		expect(setDefaultButtons).toHaveLength(1);

		await fireEvent.click(setDefaultButtons[0]);

		expect(updateLanguageSettings).toHaveBeenCalledTimes(1);
		expect(updateLanguageSettings).toHaveBeenCalledWith({ defaultProfileId: 'p1' });
		expect(refreshAll).toHaveBeenCalledTimes(1);
	});

	it('shows the empty state with a create CTA when no profiles exist', async () => {
		render(LanguageProfilesManager, { props: { profiles: [], defaultProfileId: null } });

		expect(screen.getByText('No language profiles configured')).not.toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: /create your first profile/i }));
		expect(screen.getByLabelText(/profile name/i)).not.toBeNull();
	});
});

describe('language profile editor payload', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it('creates a profile with the v2 audio/subtitles shape', async () => {
		renderManager(null);

		await fireEvent.click(screen.getByRole('button', { name: /add profile/i }));
		await fireEvent.input(screen.getByLabelText(/profile name/i), {
			target: { value: 'Test Profile' }
		});
		await fireEvent.click(screen.getByRole('button', { name: /create/i }));

		expect(createLanguageProfile).toHaveBeenCalledTimes(1);
		expect(createLanguageProfile).toHaveBeenCalledWith(
			expect.objectContaining({
				name: 'Test Profile',
				audio: { preferOriginal: true, languages: [], mode: 'prefer' as const },
				subtitles: [{ tag: 'en', variant: 'regular', accessibility: 'any' }],
				cutoffRank: null,
				minimumScore: 70,
				upgradesAllowed: true
			})
		);
	});

	it('sends the require audio mode when selected in the editor', async () => {
		renderManager(null);

		await fireEvent.click(screen.getByRole('button', { name: /add profile/i }));
		await fireEvent.input(screen.getByLabelText(/profile name/i), {
			target: { value: 'Strict Profile' }
		});
		await fireEvent.change(screen.getByLabelText(/audio matching/i), {
			target: { value: 'require' }
		});
		await fireEvent.click(screen.getByRole('button', { name: /create/i }));

		expect(createLanguageProfile).toHaveBeenCalledTimes(1);
		expect(createLanguageProfile).toHaveBeenCalledWith(
			expect.objectContaining({
				audio: expect.objectContaining({ mode: 'require' })
			})
		);
	});

	it('blocks saving when two subtitle requirements are identical and recovers once they differ', async () => {
		renderManager(null);

		await fireEvent.click(screen.getByRole('button', { name: /add profile/i }));
		await fireEvent.input(screen.getByLabelText(/profile name/i), {
			target: { value: 'Test Profile' }
		});

		// A second identical row (en/regular/any) duplicates the seeded first one.
		await fireEvent.click(screen.getByRole('button', { name: 'Add Language' }));

		expect(screen.getByText('Duplicate subtitle requirements are not allowed.')).not.toBeNull();
		expect(screen.getByRole('button', { name: /create/i }).hasAttribute('disabled')).toBe(true);

		const languageSelects = screen.getAllByRole('combobox', { name: 'Subtitle language' });
		await fireEvent.change(languageSelects[1], { target: { value: 'de' } });

		expect(screen.queryByText('Duplicate subtitle requirements are not allowed.')).toBeNull();
		expect(screen.getByRole('button', { name: /create/i }).hasAttribute('disabled')).toBe(false);
	});

	it('pre-fills a duplicated profile in add mode with a copy suffix', async () => {
		renderManager(null);

		await fireEvent.click(screen.getAllByRole('button', { name: 'Duplicate profile' })[0]);

		const nameInput = screen.getByLabelText(/profile name/i) as HTMLInputElement;
		expect(nameInput.value).toBe('English (copy)');
	});
});

describe('language profile editor labels via paraglide keys', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders variant/accessibility select options from message keys', async () => {
		renderManager(null);

		await fireEvent.click(screen.getByRole('button', { name: /add profile/i }));

		const variantSelect = screen.getByRole('combobox', {
			name: 'Subtitle variant'
		}) as HTMLSelectElement;
		const variantOptions = within(variantSelect)
			.getAllByRole('option')
			.map((o) => o.textContent);
		expect(variantOptions).toEqual(['Regular', 'Forced', 'Both (regular + forced)']);

		const accessibilitySelect = screen.getByRole('combobox', {
			name: 'Subtitle accessibility'
		}) as HTMLSelectElement;
		const accessibilityOptions = within(accessibilitySelect)
			.getAllByRole('option')
			.map((o) => o.textContent);
		expect(accessibilityOptions).toEqual(['Any', 'Prefer HI', 'Require HI', 'Exclude HI']);
	});

	it('labels the requirement selects via aria-label keys', async () => {
		renderManager(null);

		await fireEvent.click(screen.getByRole('button', { name: /add profile/i }));

		expect(screen.getByRole('combobox', { name: 'Subtitle language' })).not.toBeNull();
		expect(screen.getByRole('combobox', { name: 'Subtitle variant' })).not.toBeNull();
		expect(screen.getByRole('combobox', { name: 'Subtitle accessibility' })).not.toBeNull();
	});

	it('exposes the cutoff as a per-row toggle button', async () => {
		renderManager(null);

		await fireEvent.click(screen.getByRole('button', { name: /add profile/i }));

		const flag = screen.getAllByRole('button', { name: 'Mark as cutoff' })[0];
		expect(flag.getAttribute('aria-pressed')).toBe('false');

		await fireEvent.click(flag);
		expect(flag.getAttribute('aria-pressed')).toBe('true');

		// Clicking the flagged row again clears the cutoff.
		await fireEvent.click(flag);
		expect(flag.getAttribute('aria-pressed')).toBe('false');
	});

	it('labels the reorder buttons via aria-label keys', async () => {
		renderManager(null);

		await fireEvent.click(screen.getByRole('button', { name: /add profile/i }));

		expect(screen.getByRole('button', { name: 'Move subtitle requirement up' })).not.toBeNull();
		expect(screen.getByRole('button', { name: 'Move subtitle requirement down' })).not.toBeNull();
	});

	it('badges require-mode profiles on the card', () => {
		const original = profiles[0].audio;
		profiles[0].audio = { preferOriginal: true, languages: ['es', 'en'], mode: 'require' };
		try {
			renderManager(null);
			expect(screen.getByText('Require')).not.toBeNull();
		} finally {
			profiles[0].audio = original;
		}
	});

	it('renders the audio section strings from message keys', async () => {
		renderManager(null);

		await fireEvent.click(screen.getByRole('button', { name: /add profile/i }));

		expect(screen.getByText('Audio & Matching')).not.toBeNull();
		expect(screen.getByText('Prefer original audio track')).not.toBeNull();
		expect(screen.getByText('Preferred audio languages')).not.toBeNull();
		expect(screen.getByRole('button', { name: 'Add audio language' })).not.toBeNull();
		// No audio language rows yet: the per-row controls appear only after adding one.
		await fireEvent.click(screen.getByRole('button', { name: 'Add audio language' }));
		expect(screen.getByRole('combobox', { name: 'Preferred audio language' })).not.toBeNull();
		expect(screen.getByRole('button', { name: 'Move audio language up' })).not.toBeNull();
		expect(screen.getByRole('button', { name: 'Move audio language down' })).not.toBeNull();
		expect(screen.getByRole('button', { name: 'Remove audio language' })).not.toBeNull();
	});

	it('renders the profile card summary from message keys', () => {
		renderManager('p2');

		// p2 has preferred audio languages, so the summary line renders:
		// "<Audio:> <prefer original> · French".
		const summary = screen.getByText(/prefer original/);
		expect(summary.textContent).toContain('Audio:');
	});
});

describe('language profile deletion', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({
					directMovies: 2,
					directSeries: 1,
					viaLibraries: 0,
					smartLists: 0,
					isInstanceDefault: false
				})
			})
		);
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it('renders the usage impact inside the confirm dialog before deleting', async () => {
		renderManager(null);

		await fireEvent.click(screen.getAllByRole('button', { name: 'Delete profile' })[0]);

		expect(screen.getByText(/used directly by 2 movie\(s\) and 1 series/)).not.toBeNull();
		expect(screen.queryByText(/Usage preview is unavailable/)).toBeNull();

		await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

		expect(deleteLanguageProfile).toHaveBeenCalledWith('p1');
		expect(refreshAll).toHaveBeenCalled();
	});
});
