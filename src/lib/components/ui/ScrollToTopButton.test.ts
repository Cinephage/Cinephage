// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import ScrollToTopButton from './ScrollToTopButton.svelte';

function scrollTo(y: number): Promise<boolean> {
	Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true });
	return fireEvent.scroll(window);
}

describe('ScrollToTopButton', () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
	});

	it('is hidden until the page is scrolled past the threshold', async () => {
		render(ScrollToTopButton);
		expect(screen.queryByRole('button', { name: 'Scroll to top' })).toBeNull();

		await scrollTo(301);
		expect(screen.getByRole('button', { name: 'Scroll to top' })).toBeTruthy();

		await scrollTo(100);
		expect(screen.queryByRole('button', { name: 'Scroll to top' })).toBeNull();
	});

	it('scrolls the window smoothly to the top when clicked', async () => {
		const spy = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
		render(ScrollToTopButton);
		await scrollTo(500);

		await fireEvent.click(screen.getByRole('button', { name: 'Scroll to top' }));
		expect(spy).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
	});

	// On phones the old fixed right-6 bottom-6 placement sat on top of the
	// rightmost table column (Time) and ignored the home-indicator inset.
	it('uses a tighter, safe-area aware offset on phones and the wide offset from sm up', async () => {
		render(ScrollToTopButton);
		await scrollTo(500);

		const classes = screen.getByRole('button', { name: 'Scroll to top' }).classList;
		expect(classes.contains('right-3')).toBe(true);
		expect(classes.contains('bottom-[max(0.75rem,env(safe-area-inset-bottom))]')).toBe(true);
		expect(classes.contains('sm:right-6')).toBe(true);
		expect(classes.contains('sm:bottom-6')).toBe(true);
		expect(classes.contains('right-6')).toBe(false);
		expect(classes.contains('bottom-6')).toBe(false);
	});
});
