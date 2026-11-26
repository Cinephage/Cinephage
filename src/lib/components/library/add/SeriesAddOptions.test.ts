// @vitest-environment jsdom
/**
 * The Add to Library dialog uses normal-size selects and toggles; the series
 * options must not mix small ones in among them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { SvelteSet } from 'svelte/reactivity';
import SeriesAddOptions from './SeriesAddOptions.svelte';

describe('SeriesAddOptions control sizes', () => {
	afterEach(() => {
		cleanup();
	});

	it('uses normal-size selects and toggles throughout', () => {
		const { container } = render(SeriesAddOptions, {
			props: {
				seasons: [{ season_number: 1, name: 'Season 1', episode_count: 10 }],
				monitorType: 'all',
				monitorNewItems: 'all',
				monitorSpecials: false,
				seriesType: 'standard',
				seasonFolder: true,
				monitoredSeasons: new SvelteSet<number>([1]),
				showAdvanced: true
			}
		});

		const seriesType = container.querySelector('#series-type') as HTMLSelectElement;
		expect(seriesType).toBeTruthy();
		expect(seriesType.classList.contains('select-sm')).toBe(false);

		const toggles = Array.from(container.querySelectorAll('input.toggle'));
		expect(toggles.length).toBeGreaterThanOrEqual(3);
		for (const toggle of toggles) {
			expect(toggle.classList.contains('toggle-sm')).toBe(false);
		}
		for (const select of Array.from(container.querySelectorAll('select'))) {
			expect(select.classList.contains('select-sm')).toBe(false);
		}
	});
});
