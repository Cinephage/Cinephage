// @vitest-environment jsdom
/**
 * The More dropdown on library detail pages (desktop row and phone bar):
 * Escape closes the menu and hands focus back to the More trigger instead of
 * dropping it on <body>, and menu entries still run their action.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { Trash2 } from '@lucide/svelte';
import DetailActionBar from './DetailActionBar.svelte';
import DetailMobileBar from './DetailMobileBar.svelte';
import type { DetailAction } from './detail-actions.js';

function menu(onSelect: () => void): DetailAction[] {
	return [{ key: 'delete', label: 'Delete', icon: Trash2, onSelect, tone: 'error' }];
}

function parts(container: HTMLElement) {
	const dropdown = container.querySelector<HTMLElement>('.dropdown')!;
	const trigger = dropdown.querySelector<HTMLButtonElement>(':scope > button')!;
	const item = screen.getByRole('button', { name: 'Delete' });
	return { dropdown, trigger, item };
}

const cases = [
	{
		name: 'DetailActionBar',
		renderBar: (onSelect: () => void) =>
			render(DetailActionBar, {
				props: { backHref: '/library/movies', backLabel: 'Movies', menu: menu(onSelect) }
			})
	},
	{
		name: 'DetailMobileBar',
		renderBar: (onSelect: () => void) =>
			render(DetailMobileBar, { props: { menu: menu(onSelect) } })
	}
];

describe.each(cases)('$name More menu', ({ renderBar }) => {
	afterEach(() => cleanup());

	it('Escape from a menu item closes the menu and focuses the More trigger', async () => {
		const { container } = renderBar(vi.fn());
		const { dropdown, trigger, item } = parts(container);
		item.focus();
		await fireEvent.keyDown(item, { key: 'Escape' });
		expect(document.activeElement).toBe(trigger);
		expect(dropdown.classList.contains('dropdown-close')).toBe(true);
	});

	it('clicking a menu item runs its action once', async () => {
		const onSelect = vi.fn();
		const { container } = renderBar(onSelect);
		const { item } = parts(container);
		await fireEvent.click(item);
		expect(onSelect).toHaveBeenCalledOnce();
	});
});
