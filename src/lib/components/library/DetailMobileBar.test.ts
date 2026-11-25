// @vitest-environment jsdom
/**
 * The phone action bar's More menu is anchored to the bar's right end
 * (dropdown-end), which is the screen edge. It needs its own right margin so
 * it does not touch the edge of the screen.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { Trash2, Eye } from '@lucide/svelte';
import DetailMobileBar from './DetailMobileBar.svelte';

describe('DetailMobileBar More menu', () => {
	afterEach(() => {
		cleanup();
	});

	it('keeps the menu off the right screen edge and opens it upward', () => {
		const { container } = render(DetailMobileBar, {
			props: {
				actions: [{ key: 'monitor', label: 'Monitor', icon: Eye, onSelect: vi.fn() }],
				menu: [{ key: 'delete', label: 'Delete', icon: Trash2, tone: 'error', onSelect: vi.fn() }]
			}
		});

		const menu = container.querySelector('ul.dropdown-content') as HTMLElement;
		expect(menu).toBeTruthy();
		expect(menu.classList.contains('mr-2')).toBe(true);

		const wrapper = menu.parentElement as HTMLElement;
		expect(wrapper.classList.contains('dropdown-end')).toBe(true);
		expect(wrapper.classList.contains('dropdown-top')).toBe(true);
	});
});
