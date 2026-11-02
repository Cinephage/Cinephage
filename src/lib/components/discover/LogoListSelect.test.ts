// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

import LogoListSelect from './LogoListSelect.svelte';

const items = [
	{ id: 56, name: 'Cartoon Network', logoPath: '/cn_logo.png' },
	{ id: 13, name: 'Nickelodeon', logoPath: null },
	{ id: 49, name: 'HBO', logoPath: '/hbo_logo.png' }
];

describe('LogoListSelect', () => {
	afterEach(cleanup);

	it('renders every item name', () => {
		render(LogoListSelect, {
			props: { items, selected: [], onToggle: vi.fn(), searchable: true }
		});
		expect(screen.getByTitle('Cartoon Network')).toBeTruthy();
		expect(screen.getByTitle('Nickelodeon')).toBeTruthy();
		expect(screen.getByTitle('HBO')).toBeTruthy();
	});

	it('filters items by search text', async () => {
		render(LogoListSelect, {
			props: { items, selected: [], onToggle: vi.fn(), searchable: true }
		});
		await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'cart' } });
		expect(screen.getByTitle('Cartoon Network')).toBeTruthy();
		expect(screen.queryByTitle('HBO')).toBeNull();
	});

	it('shows the empty-search message when nothing matches', async () => {
		render(LogoListSelect, {
			props: { items, selected: [], onToggle: vi.fn(), searchable: true }
		});
		await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'showtime' } });
		expect(screen.getByText('No matches')).toBeTruthy();
	});

	it('emits toggles with the item id', async () => {
		const onToggle = vi.fn();
		render(LogoListSelect, {
			props: { items, selected: [56], onToggle, searchable: false }
		});
		await fireEvent.click(screen.getByTitle('HBO'));
		expect(onToggle).toHaveBeenCalledWith(49);
	});
});
