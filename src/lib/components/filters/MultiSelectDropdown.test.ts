// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

import MultiSelectDropdown from './MultiSelectDropdown.svelte';

const options = [
	{ id: 'christmas', label: 'Christmas' },
	{ id: 'halloween', label: 'Halloween' }
];

describe('MultiSelectDropdown', () => {
	afterEach(cleanup);

	it('single mode renders real radios that share one name', async () => {
		render(MultiSelectDropdown, {
			props: {
				id: 'seasonal',
				label: 'Seasonal',
				options,
				selected: [],
				mode: 'single',
				placeholder: 'None',
				onToggle: vi.fn()
			}
		});
		await fireEvent.click(screen.getByRole('button', { name: 'None' }));
		const radios = screen.getAllByRole('radio') as HTMLInputElement[];
		expect(radios).toHaveLength(2);
		for (const radio of radios) {
			expect(radio.name).toBe('seasonal-option');
			expect(radio.classList.contains('radio')).toBe(true);
			expect(radio.classList.contains('checkbox')).toBe(false);
		}
	});

	it('multiple mode keeps checkboxes without a shared name', async () => {
		render(MultiSelectDropdown, {
			props: {
				id: 'genres',
				label: 'Genres',
				options,
				selected: [],
				placeholder: 'Any genre',
				onToggle: vi.fn()
			}
		});
		await fireEvent.click(screen.getByRole('button', { name: 'Any genre' }));
		const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
		expect(boxes).toHaveLength(2);
		expect(boxes[0].name).toBe('');
	});
});
