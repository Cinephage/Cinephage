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
});
