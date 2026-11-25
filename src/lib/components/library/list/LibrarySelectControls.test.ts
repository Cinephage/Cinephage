// @vitest-environment jsdom
/**
 * The header toggle only leaves select mode once everything is selected, and
 * phones have no Escape key. While selecting there must always be a one-tap way
 * out, and select-all must stay reachable.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import LibrarySelectControls from './LibrarySelectControls.svelte';
import * as m from '#lib/paraglide/messages.js';

afterEach(cleanup);

function setup(mode: boolean, allSelected: boolean) {
	const onCycle = vi.fn();
	const onExit = vi.fn();
	render(LibrarySelectControls, { props: { mode, allSelected, onCycle, onExit } });
	return { onCycle, onExit };
}

/** The separate Done button (it carries a title; the toggle does not). */
function doneButton() {
	return screen.getByTitle(m.library_selectToggle_done());
}

describe('LibrarySelectControls', () => {
	it('shows only the start toggle outside select mode', () => {
		setup(false, false);

		expect(screen.getAllByRole('button')).toHaveLength(1);
		expect(screen.getByLabelText(m.library_selectToggle_start())).toBeTruthy();
		expect(screen.queryByLabelText(m.library_selectToggle_done())).toBeNull();
	});

	it('offers a one-tap exit with nothing selected, keeping select-all', async () => {
		const { onCycle, onExit } = setup(true, false);

		const toggle = screen.getByLabelText(m.library_selectToggle_selectAll());
		const done = doneButton();
		// Label in name: the accessible name is the visible "Done".
		expect(screen.getByRole('button', { name: m.library_movies_done() })).toBe(done);

		await fireEvent.click(done);
		expect(onExit).toHaveBeenCalledTimes(1);
		expect(onCycle).not.toHaveBeenCalled();

		await fireEvent.click(toggle);
		expect(onCycle).toHaveBeenCalledTimes(1);
		expect(onExit).toHaveBeenCalledTimes(1);
	});

	it('moves focus to the toggle when Done removes itself', async () => {
		setup(true, false);
		const toggle = screen.getByLabelText(m.library_selectToggle_selectAll());

		doneButton().focus();
		await fireEvent.click(doneButton());

		expect(document.activeElement).toBe(toggle);
	});

	it('shows a single exit once everything is selected', async () => {
		const { onCycle, onExit } = setup(true, true);

		expect(screen.getAllByRole('button')).toHaveLength(1);
		expect(screen.queryByTitle(m.library_selectToggle_done())).toBeNull();

		await fireEvent.click(screen.getByLabelText(m.library_selectToggle_done()));
		expect(onCycle).toHaveBeenCalledTimes(1);
		expect(onExit).not.toHaveBeenCalled();
	});
});
