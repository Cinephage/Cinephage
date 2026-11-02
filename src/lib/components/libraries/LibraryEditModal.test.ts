// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import LibraryEditModal from './LibraryEditModal.svelte';

const { createLibrary, updateLibrary, getScoringProfiles, getLanguageProfiles, refreshAll } =
	vi.hoisted(() => ({
		createLibrary: vi.fn().mockResolvedValue({}),
		updateLibrary: vi.fn().mockResolvedValue({}),
		getScoringProfiles: vi.fn().mockResolvedValue({
			profiles: [
				{ id: 'qp-any', name: 'Any' },
				{ id: 'qp-hd', name: 'HD' }
			]
		}),
		getLanguageProfiles: vi.fn().mockResolvedValue([
			{ id: 'lp-en', name: 'English Only' },
			{ id: 'lp-jp', name: 'Japanese + English' }
		]),
		refreshAll: vi.fn().mockResolvedValue(undefined)
	}));

vi.mock('$app/navigation', () => ({ refreshAll }));

vi.mock('#lib/api/settings.js', () => ({
	createLibrary,
	updateLibrary,
	getScoringProfiles
}));

vi.mock('#lib/api/subtitles.js', () => ({
	getLanguageProfiles
}));

vi.mock('#lib/stores/toast.svelte.js', () => ({
	toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
}));

type LibraryFixture = {
	id: string;
	name: string;
	mediaType: 'movie' | 'tv';
	mediaSubType: 'standard' | 'anime';
	isSystem?: boolean;
	rootFolders: Array<{ id: string }>;
	defaultSearchOnAdd?: boolean | null;
	defaultWantsSubtitles?: boolean | null;
	qualityProfileId?: string | null;
	languageProfileId?: string | null;
};

function makeLibrary(overrides: Partial<LibraryFixture> = {}): LibraryFixture {
	return {
		id: 'lib-1',
		name: 'Movies',
		mediaType: 'movie',
		mediaSubType: 'standard',
		rootFolders: [{ id: 'root-a' }],
		defaultSearchOnAdd: true,
		defaultWantsSubtitles: true,
		qualityProfileId: null,
		languageProfileId: null,
		...overrides
	};
}

function renderModal(props: {
	libraryId: string | null;
	libraries: LibraryFixture[];
	onClose?: () => void;
}) {
	return render(LibraryEditModal, {
		props: {
			open: true,
			libraryId: props.libraryId,
			libraries: props.libraries,
			rootFolders: [{ id: 'root-a', name: 'Movies dir', path: '/mnt/movies', mediaType: 'movie' }],
			onClose: props.onClose ?? vi.fn()
		}
	});
}

describe('LibraryEditModal language profile selector', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	/** Get the language profile select and wait for the async profiles fetch. */
	async function getLoadedLanguageSelect(): Promise<HTMLSelectElement> {
		const select = (await waitFor(() =>
			screen.getByRole('combobox', { name: /subtitle profile/i })
		)) as HTMLSelectElement;
		await waitFor(() => expect(select.options.length).toBeGreaterThan(1));
		return select;
	}

	it('lists the inherit option plus one option per language profile', async () => {
		renderModal({ libraryId: null, libraries: [] });

		const select = await getLoadedLanguageSelect();

		const optionLabels = Array.from(select.options).map((o) => o.textContent);
		expect(optionLabels).toContain('Inherit (instance default)');
		expect(optionLabels).toContain('English Only');
		expect(optionLabels).toContain('Japanese + English');
	});

	it('create payload includes languageProfileId: null when inherit is selected', async () => {
		renderModal({ libraryId: null, libraries: [] });

		const name = screen.getByLabelText(/library name/i);
		await fireEvent.input(name, { target: { value: 'New Lib' } });

		await fireEvent.click(screen.getByRole('button', { name: /save library/i }));
		await waitFor(() => expect(createLibrary).toHaveBeenCalled());

		expect(createLibrary).toHaveBeenCalledWith(
			expect.objectContaining({ languageProfileId: null })
		);
	});

	it('create payload persists the selected profile id', async () => {
		renderModal({ libraryId: null, libraries: [] });

		const select = await getLoadedLanguageSelect();
		await fireEvent.change(select, { target: { value: 'lp-jp' } });
		await fireEvent.click(screen.getByRole('button', { name: /save library/i }));
		await waitFor(() => expect(createLibrary).toHaveBeenCalled());

		expect(createLibrary).toHaveBeenCalledWith(
			expect.objectContaining({ languageProfileId: 'lp-jp' })
		);
	});

	it('edit payload normalizes the inherit selection to null', async () => {
		renderModal({ libraryId: 'lib-1', libraries: [makeLibrary({ languageProfileId: 'lp-en' })] });

		const select = await getLoadedLanguageSelect();
		expect(select.value).toBe('lp-en');

		await fireEvent.change(select, { target: { value: '' } });
		await fireEvent.click(screen.getByRole('button', { name: /save library/i }));
		await waitFor(() => expect(updateLibrary).toHaveBeenCalled());

		expect(updateLibrary).toHaveBeenCalledWith(
			'lib-1',
			expect.objectContaining({ languageProfileId: null })
		);
	});

	it('prefills the library language profile when editing', async () => {
		renderModal({
			libraryId: 'lib-1',
			libraries: [makeLibrary({ languageProfileId: 'lp-jp' })]
		});

		const select = await getLoadedLanguageSelect();
		expect(select.value).toBe('lp-jp');

		await fireEvent.click(screen.getByRole('button', { name: /save library/i }));
		await waitFor(() => expect(updateLibrary).toHaveBeenCalled());

		expect(updateLibrary).toHaveBeenCalledWith(
			'lib-1',
			expect.objectContaining({ languageProfileId: 'lp-jp' })
		);
	});
});
