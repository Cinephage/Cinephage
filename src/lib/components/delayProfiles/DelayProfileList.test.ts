// @vitest-environment jsdom
/**
 * The delay profile dialog uses normal-size inputs and selects; its toggles
 * must match them instead of being the small variant.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import * as m from '#lib/paraglide/messages.js';

vi.mock('$app/navigation', () => ({ refreshAll: vi.fn() }));
vi.mock('#lib/api/delay-profiles.js', () => ({
	createDelayProfile: vi.fn(),
	updateDelayProfile: vi.fn(),
	deleteDelayProfile: vi.fn()
}));

import DelayProfileList from './DelayProfileList.svelte';

describe('DelayProfileList dialog control sizes', () => {
	afterEach(() => {
		cleanup();
	});

	it('renders normal-size toggles next to normal-size inputs', async () => {
		render(DelayProfileList, { props: { delayProfiles: [] } });
		const [add] = screen.getAllByRole('button', { name: m.settings_quality_delay_addProfile() });
		await fireEvent.click(add);

		await screen.findByText(m.settings_quality_delay_modalAddTitle());
		const toggles = Array.from(document.querySelectorAll('input.toggle'));
		expect(toggles.length).toBe(2);
		for (const toggle of toggles) {
			expect(toggle.classList.contains('toggle-sm')).toBe(false);
		}
	});
});
