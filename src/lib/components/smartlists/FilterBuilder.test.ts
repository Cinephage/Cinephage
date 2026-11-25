// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';

type Pending = { helper: string; resolve: (value: unknown) => void };

const { getSmartListHelpers, pending } = vi.hoisted(() => {
	const pending: Pending[] = [];
	const getSmartListHelpers = vi.fn(
		(params: { helper: string }) =>
			new Promise<unknown>((resolve) => {
				pending.push({ helper: params.helper, resolve });
			})
	);
	return { getSmartListHelpers, pending };
});

vi.mock('#lib/api/smartlists.js', () => ({ getSmartListHelpers }));
vi.mock('$app/state', () => ({ page: { data: { defaultRegion: 'US' } } }));

import FilterBuilder from './FilterBuilder.svelte';

async function settle() {
	for (let i = 0; i < 3; i++) {
		await Promise.resolve();
		await tick();
	}
}

function resolveHelper(helper: string, value: unknown) {
	for (const entry of pending.filter((p) => p.helper === helper)) entry.resolve(value);
}

function callsFor(helper: string) {
	return getSmartListHelpers.mock.calls.filter(([params]) => params.helper === helper).length;
}

describe('FilterBuilder helper lookups', () => {
	afterEach(() => {
		cleanup();
		getSmartListHelpers.mockClear();
		pending.length = 0;
	});

	it('loads languages and countries once each', async () => {
		render(FilterBuilder, { props: { mediaType: 'movie', filters: {} } });
		await settle();

		resolveHelper('languages', [{ iso_639_1: 'en', english_name: 'English' }]);
		await settle();
		resolveHelper('countries', [{ iso_3166_1: 'US', english_name: 'United States' }]);
		await settle();

		expect(callsFor('languages')).toBe(1);
		expect(callsFor('countries')).toBe(1);
	});
});
