// @vitest-environment jsdom
/**
 * LibraryMediaMobileCard toolbar touch targets.
 *
 * The card is the library list below lg, so its toolbar is what phones tap:
 * every button must be at least btn-sm (32 px), and Delete must sit last with
 * its own spacing so a slightly-off tap on Search does not hit it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import LibraryMediaMobileCard from './LibraryMediaMobileCard.svelte';
import type { MediaRowView } from './media-view.js';
import * as m from '#lib/paraglide/messages.js';

const row: MediaRowView = {
	id: 'movie-1',
	kind: 'movie',
	href: '/library/movie/movie-1',
	title: 'Example Movie',
	year: 2001,
	art: null,
	square: false,
	typeLabel: 'Movie',
	typeTone: 'primary',
	monitored: true,
	hideMonitored: false,
	partiallyMonitored: false,
	state: null,
	detail: null,
	progress: null,
	subtitle: null,
	tag: null,
	qualityBadges: [],
	profileLabel: null,
	sizeLabel: null,
	progressLabel: null,
	added: null
};

function renderCard() {
	return render(LibraryMediaMobileCard, {
		props: {
			row,
			selected: false,
			selectable: false,
			isLoading: false,
			downloadingIds: new Set<string>(),
			onSelectChange: vi.fn(),
			onMonitorToggle: vi.fn(),
			onAutoGrab: vi.fn(),
			onManualGrab: vi.fn(),
			onDelete: vi.fn(),
			onNavigate: vi.fn()
		}
	});
}

afterEach(() => {
	cleanup();
});

describe('LibraryMediaMobileCard toolbar touch targets', () => {
	it('uses btn-sm, not btn-xs, for every toolbar button', () => {
		renderCard();
		const buttons = screen.getByRole('toolbar').querySelectorAll('button');
		expect(buttons.length).toBe(4);
		for (const button of buttons) {
			expect(button.classList.contains('btn-sm')).toBe(true);
			expect(button.classList.contains('btn-xs')).toBe(false);
		}
	});

	it('puts Delete last, after Search, with its own spacing', () => {
		renderCard();
		const toolbar = screen.getByRole('toolbar');
		const deleteButton = screen.getByRole('button', { name: m.action_delete() });
		const searchButton = screen.getByRole('button', {
			name: m.library_libraryMediaTable_manualGrabButton()
		});

		expect(toolbar.lastElementChild).toBe(deleteButton);
		expect(deleteButton.previousElementSibling).toBe(searchButton);
		expect(deleteButton.classList.contains('ml-2')).toBe(true);
	});
});
