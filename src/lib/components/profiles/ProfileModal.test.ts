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
		await fireEvent.click(screen.getByRole('button', { name: /indexers/i }));
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

		await fireEvent.click(screen.getByRole('button', { name: /indexers/i }));
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
