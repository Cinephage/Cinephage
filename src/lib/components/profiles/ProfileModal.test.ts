// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import ProfileModal from './ProfileModal.svelte';
import type { ScoringProfile, ScoringProfileFormData } from '#lib/types/profile.js';

const indexers = [
	{ id: 'ix-a', name: 'Alpha Tracker', protocol: 'torrent' as const, enabled: true },
	{ id: 'ix-b', name: 'Beta News', protocol: 'usenet' as const, enabled: true },
	{ id: 'ixc', name: 'Gamma Stream', protocol: 'streaming' as const, enabled: false }
];

const baseProfile: ScoringProfile = {
	id: 'custom-1',
	name: 'Custom One',
	description: '',
	tags: [],
	upgradesAllowed: true,
	preventDowngrades: false,
	minScore: 0,
	upgradeUntilScore: -1,
	minScoreIncrement: 0,
	resolutionOrder: [],
	formatScores: {},
	isDefault: false,
	isBuiltIn: false,
	allowedIndexerIds: null
};

describe('ProfileModal indexer allowlist', () => {
	let onSave: (data: ScoringProfileFormData) => void;

	beforeEach(() => {
		onSave = vi.fn<(data: ScoringProfileFormData) => void>();
	});

	afterEach(() => {
		cleanup();
	});

	const openIndexersTab = async () => {
		await fireEvent.click(screen.getByRole('tab', { name: /indexers/i }));
	};

	function renderModal(profile: ScoringProfile = baseProfile) {
		return render(ProfileModal, {
			props: {
				open: true,
				mode: 'edit' as const,
				profile,
				allProfiles: [{ id: 'balanced', name: 'Balanced', isBuiltIn: true }],
				allFormats: [],
				indexers,
				onClose: vi.fn(),
				onSave
			}
		});
	}

	const saveButton = () => screen.getByRole('button', { name: /save/i });

	it('defaults to all indexers and saves null', async () => {
		renderModal();

		await openIndexersTab();
		expect(screen.getByRole('button', { name: /^all indexers$/i }).className).toContain(
			'btn-primary'
		);

		await fireEvent.click(saveButton());

		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ allowedIndexerIds: null }));
	});

	it('seeds the selection with every indexer when switching to only-selected', async () => {
		renderModal();

		await openIndexersTab();
		await fireEvent.click(screen.getByRole('button', { name: /^only selected indexers$/i }));

		// Scope to the indexer rows: the modal also has unrelated checkboxes
		// (allow upgrades, prevent downgrades, set as default).
		const indexerBoxes = [
			screen.getByRole('checkbox', { name: /alpha tracker/i }),
			screen.getByRole('checkbox', { name: /beta news/i }),
			screen.getByRole('checkbox', { name: /gamma stream/i })
		] as HTMLInputElement[];
		expect(indexerBoxes.every((box) => box.checked)).toBe(true);

		await fireEvent.click(saveButton());

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ allowedIndexerIds: ['ix-a', 'ix-b', 'ixc'] })
		);
	});

	it('unchecking an indexer removes it from the saved allowlist', async () => {
		renderModal({
			...baseProfile,
			allowedIndexerIds: ['ix-a', 'ix-b']
		});

		await openIndexersTab();
		const beta = screen.getByRole('checkbox', { name: /beta news/i }) as HTMLInputElement;
		expect(beta.checked).toBe(true);

		await fireEvent.click(beta);
		await fireEvent.click(saveButton());

		expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ allowedIndexerIds: ['ix-a'] }));
	});

	it('blocks saving when every indexer is unchecked', async () => {
		renderModal();

		await openIndexersTab();
		await fireEvent.click(screen.getByRole('button', { name: /^only selected indexers$/i }));
		await fireEvent.click(screen.getByRole('button', { name: /clear/i }));

		expect(screen.getByText(/select at least one indexer/i)).toBeTruthy();
		expect((saveButton() as HTMLButtonElement).disabled).toBe(true);

		await fireEvent.click(saveButton());
		expect(onSave).not.toHaveBeenCalled();
	});

	it('surfaces indexers that no longer exist and keeps them out of the count', async () => {
		renderModal({
			...baseProfile,
			allowedIndexerIds: ['ix-a', 'deleted-ix']
		});

		await openIndexersTab();
		expect(screen.getByText(/no longer configured/i)).toBeTruthy();
		expect(screen.getByText(/deleted-ix/)).toBeTruthy();
		expect(screen.getByText(/1 of 3 selected/i)).toBeTruthy();
	});

	it('loads the stored allowlist when editing', async () => {
		renderModal({
			...baseProfile,
			allowedIndexerIds: ['ix-b']
		});

		await openIndexersTab();
		expect(screen.getByRole('button', { name: /^only selected indexers$/i }).className).toContain(
			'btn-primary'
		);
		expect((screen.getByRole('checkbox', { name: /beta news/i }) as HTMLInputElement).checked).toBe(
			true
		);
		expect(
			(screen.getByRole('checkbox', { name: /alpha tracker/i }) as HTMLInputElement).checked
		).toBe(false);
	});

	it('offers the indexer picker on built-in profiles too', async () => {
		render(ProfileModal, {
			props: {
				open: true,
				mode: 'edit' as const,
				profile: {
					...baseProfile,
					id: 'balanced',
					name: 'Balanced',
					isBuiltIn: true,
					allowedIndexerIds: ['ix-a']
				},
				allProfiles: [],
				allFormats: [],
				indexers,
				onClose: vi.fn(),
				onSave
			}
		});

		await fireEvent.click(screen.getByRole('tab', { name: /indexers/i }));
		expect(
			(screen.getByRole('checkbox', { name: /alpha tracker/i }) as HTMLInputElement).checked
		).toBe(true);

		await fireEvent.click(screen.getByRole('checkbox', { name: /beta news/i }));
		await fireEvent.click(saveButton());

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({ allowedIndexerIds: ['ix-a', 'ix-b'] })
		);
	});
});

describe('ProfileModal tabs a11y', () => {
	afterEach(() => {
		cleanup();
	});

	function renderTabs(
		overrides: Partial<{
			mediaKind: 'video' | 'music';
			indexers: typeof indexers;
			allFormats: { id: string; name: string; category: 'resolution' }[];
		}> = {}
	) {
		return render(ProfileModal, {
			props: {
				open: true,
				mode: 'edit' as const,
				profile: baseProfile,
				allProfiles: [],
				allFormats: [{ id: 'fmt-1', name: 'Some Format', category: 'resolution' as const }],
				indexers,
				onClose: vi.fn(),
				onSave: vi.fn(),
				...overrides
			}
		});
	}

	const tab = (name: RegExp) => screen.getByRole('tab', { name });
	const expectSelected = (selected: HTMLElement) => {
		for (const t of screen.getAllByRole('tab')) {
			const isSelected = t === selected;
			expect(t.getAttribute('aria-selected')).toBe(String(isSelected));
			expect(t.getAttribute('tabindex')).toBe(isSelected ? '0' : '-1');
		}
	};

	it('renders a labelled tablist with General selected', () => {
		renderTabs();

		const tablist = screen.getByRole('tablist');
		expect(tablist.getAttribute('aria-labelledby')).toBe('profile-modal-title');
		expect(screen.getAllByRole('tab')).toHaveLength(3);
		expectSelected(tab(/general/i));
	});

	it('wires the active tab and the tabpanel to each other', async () => {
		renderTabs();

		const panel = screen.getByRole('tabpanel');
		const general = tab(/general/i);
		expect(general.id).not.toBe('');
		expect(panel.getAttribute('aria-labelledby')).toBe(general.id);
		expect(general.getAttribute('aria-controls')).toBe(panel.id);

		await fireEvent.click(tab(/indexers/i));
		expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(tab(/indexers/i).id);
	});

	it('moves selection and focus with the arrow keys, Home and End', async () => {
		renderTabs();
		const general = tab(/general/i);
		const indexersTab = tab(/indexers/i);
		const formats = tab(/format scores/i);

		await fireEvent.keyDown(general, { key: 'ArrowRight' });
		expectSelected(indexersTab);
		expect(document.activeElement).toBe(indexersTab);
		expect(screen.getByRole('button', { name: /^all indexers$/i })).toBeTruthy();

		await fireEvent.keyDown(indexersTab, { key: 'ArrowRight' });
		expectSelected(formats);
		expect(document.activeElement).toBe(formats);

		await fireEvent.keyDown(formats, { key: 'ArrowRight' });
		expectSelected(general);
		expect(document.activeElement).toBe(general);

		await fireEvent.keyDown(general, { key: 'End' });
		expectSelected(formats);
		expect(document.activeElement).toBe(formats);

		await fireEvent.keyDown(formats, { key: 'Home' });
		expectSelected(general);
		expect(document.activeElement).toBe(general);

		await fireEvent.keyDown(general, { key: 'ArrowLeft' });
		expectSelected(formats);
		expect(document.activeElement).toBe(formats);
	});

	it('ignores keys that are not tab navigation keys', async () => {
		renderTabs();
		const general = tab(/general/i);

		await fireEvent.keyDown(general, { key: 'ArrowDown' });
		expectSelected(general);
	});

	it('still switches tabs on click', async () => {
		renderTabs();

		await fireEvent.click(tab(/format scores/i));
		expectSelected(tab(/format scores/i));
	});

	it('has no tablist or tabpanel when there is only one tab', () => {
		renderTabs({ indexers: [], allFormats: [] });

		expect(screen.queryByRole('tablist')).toBeNull();
		expect(screen.queryAllByRole('tab')).toHaveLength(0);
		expect(document.querySelector('[role="tabpanel"]')).toBeNull();
	});

	it('has no tablist or tabpanel for a music profile', () => {
		renderTabs({ mediaKind: 'music' });

		expect(screen.queryByRole('tablist')).toBeNull();
		expect(document.querySelector('[role="tabpanel"]')).toBeNull();
	});
});
