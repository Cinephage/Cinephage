// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import FiltersPage from '../../../routes/settings/library/filters/+page.svelte';
import type { PageData } from '../../../routes/settings/library/filters/$types';

const { updateTmdbFilters } = vi.hoisted(() => ({
	updateTmdbFilters: vi.fn().mockResolvedValue({})
}));

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

vi.mock('$app/state', () => ({
	page: {
		data: { defaultRegion: 'US' },
		url: new URL('http://localhost/settings/library/filters')
	}
}));

vi.mock('#lib/api/settings.js', () => ({
	updateTmdbFilters
}));

vi.mock('#lib/stores/toast.svelte.js', () => ({
	toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}));

function renderPage() {
	const data = {
		filters: {
			include_adult: true,
			min_vote_average: 6.5,
			min_vote_count: 100,
			language: 'en-US',
			region: 'US',
			excluded_genre_ids: [28]
		},
		genres: [
			{ id: 28, name: 'Action' },
			{ id: 35, name: 'Comedy' }
		],
		tmdbConfigured: true
	} as unknown as PageData;
	return render(FiltersPage, { props: { data } });
}

describe('discovery filters page after the language/region fold', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it('no longer shows the language/region localization fields', () => {
		const { container } = renderPage();

		expect(container.querySelector('#language')).toBeNull();
		expect(container.querySelector('#region')).toBeNull();
		expect(container.querySelectorAll('select')).toHaveLength(0);
	});

	it('keeps the adult, quality and genre filters editable', () => {
		const { container } = renderPage();

		const includeAdult = screen.getByRole('checkbox', {
			name: /include adult content/i
		}) as HTMLInputElement;
		expect(includeAdult.checked).toBe(true);

		const minScore = screen.getByLabelText(/minimum score/i) as HTMLInputElement;
		expect(minScore.value).toBe('6.5');

		const actionGenre = screen.getByRole('checkbox', { name: /action/i }) as HTMLInputElement;
		expect(actionGenre.checked).toBe(true);
		const comedyGenre = screen.getByRole('checkbox', { name: /comedy/i }) as HTMLInputElement;
		expect(comedyGenre.checked).toBe(false);

		expect(container).toBeTruthy();
	});

	it('still saves the remaining filters', async () => {
		renderPage();

		const minScore = screen.getByLabelText(/minimum score/i) as HTMLInputElement;
		await fireEvent.input(minScore, { target: { value: '7.2' } });
		await fireEvent.click(screen.getByRole('button', { name: /save global filters/i }));

		expect(updateTmdbFilters).toHaveBeenCalledTimes(1);
		expect(updateTmdbFilters).toHaveBeenCalledWith({
			include_adult: true,
			min_vote_average: 7.2,
			min_vote_count: 100,
			language: 'en-US',
			region: 'US',
			excluded_genre_ids: [28]
		});
	});
});
