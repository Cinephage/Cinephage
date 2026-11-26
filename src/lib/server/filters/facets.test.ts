import { describe, expect, it } from 'vitest';

import { EMPTY_FACET_OPTIONS, buildFacetGroups } from './facets.js';

function facet(id: string) {
	return buildFacetGroups('movie', {}, EMPTY_FACET_OPTIONS)
		.flatMap((group) => group.facets)
		.find((entry) => entry.id === id);
}

describe('buildFacetGroups', () => {
	it('gives the seasonal preset a "none" trigger label instead of an empty one', () => {
		const seasonal = facet('seasonal');
		expect(seasonal?.control).toBe('preset');
		expect(seasonal?.value).toBeNull();
		expect(seasonal?.placeholder).toBe('None');
	});

	it('marks only the language facet with the instance default', () => {
		const facets = buildFacetGroups('movie', {}, EMPTY_FACET_OPTIONS, { language: 'ja' }).flatMap(
			(group) => group.facets
		);
		expect(facets.find((facet) => facet.id === 'language')?.instanceDefault).toBe('ja');
		expect(
			facets.filter((facet) => facet.id !== 'language').every((facet) => !facet.instanceDefault)
		).toBe(true);
	});

	it('carries no instance default when none is given', () => {
		const facets = buildFacetGroups('movie', {}, EMPTY_FACET_OPTIONS).flatMap(
			(group) => group.facets
		);
		expect(facets.every((facet) => facet.instanceDefault === undefined)).toBe(true);
	});
});
