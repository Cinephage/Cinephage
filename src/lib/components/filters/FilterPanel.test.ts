// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

import FilterPanel from './FilterPanel.svelte';
import type { FacetGroupView } from '#lib/filters/types.js';

const musicGroups: FacetGroupView[] = [
	{
		id: 'content',
		label: 'Content',
		facets: [
			{
				id: 'music_genre',
				label: 'Genres',
				control: 'multi',
				options: [
					{ id: '132', label: 'Pop' },
					{ id: '116', label: 'Rap/Hip Hop' }
				],
				searchable: true,
				placeholder: 'Any genre',
				value: null
			}
		]
	}
];

const allGroups: FacetGroupView[] = [
	{
		id: 'sort',
		label: '',
		facets: [
			{
				id: 'sort',
				label: 'Sort By',
				control: 'single',
				options: [{ id: 'popularity.desc', label: 'Most Popular' }],
				value: { kind: 'scalar', value: 'popularity.desc' }
			}
		]
	},
	{
		id: 'availability',
		label: 'Availability',
		facets: [
			{
				id: 'networks',
				label: 'Networks',
				control: 'logo-multi',
				options: [{ id: '213', label: 'Netflix', logoPath: null }],
				hint: 'TV only',
				value: null
			}
		]
	}
];

describe('FilterPanel', () => {
	afterEach(cleanup);

	it('renders only the facets the current tab declares', () => {
		render(FilterPanel, { props: { groups: musicGroups, onchange: vi.fn() } });
		expect(screen.getByText('Content')).toBeTruthy();
		expect(screen.getByText('Genres')).toBeTruthy();
		expect(screen.queryByText('Sort By')).toBeNull();
		expect(screen.queryByText('Networks')).toBeNull();
	});

	it('emits a list value when a multi facet is picked', async () => {
		const onchange = vi.fn();
		render(FilterPanel, { props: { groups: musicGroups, onchange } });
		await fireEvent.click(screen.getByRole('button', { name: 'Any genre' }));
		await fireEvent.click(screen.getByRole('checkbox', { name: 'Pop' }));
		expect(onchange).toHaveBeenCalledWith('music_genre', { kind: 'ids', ids: ['132'] });
	});

	it('shows a facet hint when it applies to only some served kinds', () => {
		render(FilterPanel, { props: { groups: allGroups, onchange: vi.fn() } });
		expect(screen.getByText('TV only')).toBeTruthy();
		expect(screen.getByText('Sort By')).toBeTruthy();
	});

	it('emits a scalar when a single facet is picked, and clears it on a second pick', async () => {
		const onchange = vi.fn();
		render(FilterPanel, { props: { groups: allGroups, onchange } });
		await fireEvent.click(screen.getByRole('button', { name: 'Most Popular' }));
		await fireEvent.click(screen.getByRole('radio', { name: 'Most Popular' }));
		expect(onchange).toHaveBeenCalledWith('sort', null);
	});
});
