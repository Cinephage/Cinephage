// @vitest-environment jsdom
/**
 * The theme menu is a fixed 384px list. On the profile page it sits near the
 * bottom of the screen, so it must open upward there, like the language menu
 * beside it; the default (used where the caller passes nothing) stays as is.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup } from '@testing-library/svelte';

vi.mock('#lib/theme.svelte.js', () => ({ theme: { current: 'system', set: vi.fn() } }));
vi.mock('#lib/api/client.js', () => ({ apiPut: vi.fn() }));

import ThemeSelector from './ThemeSelector.svelte';

describe('ThemeSelector placement', () => {
	afterEach(() => {
		cleanup();
	});

	it('applies the placement classes it is given', () => {
		const { container } = render(ThemeSelector, {
			props: { class: 'dropdown-end dropdown-top', showLabel: false }
		});
		const root = container.querySelector('.theme-selector') as HTMLElement;

		expect(root.classList.contains('dropdown-end')).toBe(true);
		expect(root.classList.contains('dropdown-top')).toBe(true);
	});

	it('keeps the downward dropdown-end default when no class is passed', () => {
		const { container } = render(ThemeSelector, { props: { showLabel: false } });
		const root = container.querySelector('.theme-selector') as HTMLElement;

		expect(root.classList.contains('dropdown-end')).toBe(true);
		expect(root.classList.contains('dropdown-top')).toBe(false);
	});

	it('opens upward on the profile page', () => {
		const source = readFileSync(resolve(process.cwd(), 'src/routes/profile/+page.svelte'), 'utf8');
		const line = source.split('\n').find((l) => l.includes('<ThemeSelector'));

		expect(line).toBeDefined();
		expect(line).toContain('dropdown-top');
	});
});
