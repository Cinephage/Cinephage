import { describe, expect, it } from 'vitest';

import { hasActiveDiscoverFilters, isDefaultView, parseDiscoverParams } from './discoverParams.js';

function paramsFrom(query: string) {
	return parseDiscoverParams(new URLSearchParams(query));
}

describe('parseDiscoverParams', () => {
	it('reads the with_networks filter', () => {
		const params = paramsFrom('with_networks=56,13');
		expect(params.withNetworks).toBe('56,13');
	});

	it('defaults with_networks to empty', () => {
		expect(paramsFrom('').withNetworks).toBe('');
	});
});

describe('isDefaultView', () => {
	it('stays default when no filters are set', () => {
		expect(isDefaultView(new URLSearchParams(''), paramsFrom(''))).toBe(true);
	});

	it('leaves the default view when a network filter is present', () => {
		const search = new URLSearchParams('with_networks=56');
		expect(isDefaultView(search, paramsFrom('with_networks=56'))).toBe(false);
	});
});

describe('hasActiveDiscoverFilters', () => {
	const base = paramsFrom('');

	it('is false for defaults', () => {
		expect(hasActiveDiscoverFilters(base)).toBe(false);
	});

	it('is true when networks are selected', () => {
		expect(hasActiveDiscoverFilters({ ...base, withNetworks: '56' })).toBe(true);
	});
});
