// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

import DiscoverSearchBox from './DiscoverSearchBox.svelte';

function setup(query = 'matrix') {
	const onkeydown = vi.fn();
	const oninput = vi.fn();
	const onclear = vi.fn();
	const view = render(DiscoverSearchBox, {
		props: { query, searching: false, oninput, onkeydown, onclear }
	});
	// Like the page: clearing empties the query, which unmounts the button.
	onclear.mockImplementation(() => void view.rerender({ query: '' }));
	return { onkeydown, oninput, onclear };
}

const clearButton = () => screen.getByRole('button', { name: 'Clear search' });

describe('DiscoverSearchBox', () => {
	afterEach(cleanup);

	it('puts focus back in the input after a tap on clear', async () => {
		const { onclear } = setup();
		const button = clearButton();
		// A real tap focuses the button before the click lands.
		button.focus();
		await fireEvent.click(button);
		await tick();

		expect(onclear).toHaveBeenCalledOnce();
		expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole('textbox'));
		expect(document.activeElement).not.toBe(document.body);
	});

	it('puts focus back in the input when clear is used from the keyboard', async () => {
		setup();
		const button = clearButton();
		button.focus();
		expect(document.activeElement).toBe(button);
		// Enter/Space on a focused button dispatches a click.
		await fireEvent.click(button);
		await tick();

		expect(document.activeElement).toBe(screen.getByRole('textbox'));
	});

	it('keeps the input focused through a mouse/touch press on clear', async () => {
		setup();
		const input = screen.getByRole('textbox');
		input.focus();
		const notCancelled = await fireEvent.mouseDown(clearButton());
		expect(notCancelled).toBe(false);
	});

	it('shows no clear button for an empty query', () => {
		setup('');
		expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
	});

	it('gives the clear button a 32 px target and type="button"', () => {
		setup();
		const button = clearButton();
		expect(button.getAttribute('type')).toBe('button');
		expect(button.classList.contains('size-8')).toBe(true);
	});

	it('passes Escape and Enter on the input through to onkeydown', async () => {
		const { onkeydown } = setup();
		const input = screen.getByRole('textbox');
		await fireEvent.keyDown(input, { key: 'Escape' });
		await fireEvent.keyDown(input, { key: 'Enter' });

		expect(onkeydown).toHaveBeenCalledTimes(2);
		expect(onkeydown.mock.calls.map(([e]) => (e as KeyboardEvent).key)).toEqual([
			'Escape',
			'Enter'
		]);
	});
});
